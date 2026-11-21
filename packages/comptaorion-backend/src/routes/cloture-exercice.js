import express from 'express';
import { db } from '../db.js';
import {
  auditLogs,
  comptesComptables,
  ecritures,
  journaux,
  lignesEcritures,
} from '../schema.js';
import { and, eq, gte, lte } from 'drizzle-orm';

// Clôture d'exercice (ComptaOrioLite) — extrait verbatim de
// routes/comptabilite.js, qui n'est pas monté dans app.js. Ce routeur est
// monté dans app.js sous /api, donc :
//   GET  /api/cloture-exercice/preview?annee=2025
//   POST /api/cloture-exercice { annee }
// Lite est services uniquement : la clôture ne touche que le grand livre
// (comptes, écritures, lignes, journaux OD/AN, audit) — aucune table de
// stock, aucun achat, aucune TVA. Le résultat est reporté en 120 (bénéfice)
// ou 129 (perte) et le bilan d'ouverture AN-{année+1} reprend les soldes.
// Il n'existe pas de route de réouverture dans Lite (contrairement à
// ComptaOrion) : une clôture exécutée ne peut pas être annulée par l'API.

const router = express.Router();

// ==========================================
// CLÔTURE D'EXERCICE
// ==========================================

// Prévisualisation de la clôture (sans exécution)
router.get('/cloture-exercice/preview', async (req, res) => {
  try {
    const entrepriseId = req.entrepriseId;
    const { annee } = req.query;

    if (!entrepriseId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }
    if (!annee) {
      return res.status(400).json({ error: 'Année requise' });
    }

    const dateDebut = `${annee}-01-01`;
    const dateFin = `${annee}-12-31`;

    // Récupérer tous les comptes
    const comptesData = await db.query.comptesComptables.findMany({
      where: eq(comptesComptables.entrepriseId, entrepriseId)
    });

    // Récupérer les lignes d'écritures de l'exercice
    const conditions = [
      eq(ecritures.entrepriseId, entrepriseId),
      gte(ecritures.dateEcriture, new Date(dateDebut)),
      lte(ecritures.dateEcriture, new Date(dateFin))
    ];

    const ecrituresData = await db
      .select({ id: ecritures.id })
      .from(ecritures)
      .where(and(...conditions));

    const ecritureIds = ecrituresData.map(e => e.id);

    // Calculer les soldes par compte
    const soldesMap = {};
    if (ecritureIds.length > 0) {
      const lignesData = await db
        .select({
          compteComptableId: lignesEcritures.compteComptableId,
          debit: lignesEcritures.debit,
          credit: lignesEcritures.credit
        })
        .from(lignesEcritures)
        .where(eq(lignesEcritures.entrepriseId, entrepriseId));

      // Filtrer les lignes qui correspondent aux écritures de l'exercice
      const ecritureIdsSet = new Set(ecritureIds);
      const lignesExercice = await db
        .select({
          compteComptableId: lignesEcritures.compteComptableId,
          debit: lignesEcritures.debit,
          credit: lignesEcritures.credit,
          ecritureId: lignesEcritures.ecritureId
        })
        .from(lignesEcritures)
        .where(eq(lignesEcritures.entrepriseId, entrepriseId));

      lignesExercice.forEach(l => {
        if (ecritureIdsSet.has(l.ecritureId)) {
          const compteId = l.compteComptableId;
          if (!soldesMap[compteId]) soldesMap[compteId] = 0;
          soldesMap[compteId] += parseFloat(l.debit || 0) - parseFloat(l.credit || 0);
        }
      });
    }

    // Séparer comptes de résultat et comptes de bilan
    const comptesResultat = { charges: [], produits: [] };
    const comptesBilan = [];
    let totalCharges = 0;
    let totalProduits = 0;

    comptesData.forEach(compte => {
      const solde = soldesMap[compte.id] || 0;
      if (solde === 0) return;

      const classe = compte.numero.charAt(0);

      if (classe === '6') {
        // Charges (solde débiteur)
        comptesResultat.charges.push({
          numero: compte.numero,
          nom: compte.nom,
          solde: Math.abs(solde)
        });
        totalCharges += Math.abs(solde);
      } else if (classe === '7') {
        // Produits (solde créditeur)
        comptesResultat.produits.push({
          numero: compte.numero,
          nom: compte.nom,
          solde: Math.abs(solde)
        });
        totalProduits += Math.abs(solde);
      } else if (['1', '2', '3', '4', '5'].includes(classe)) {
        // Comptes de bilan
        comptesBilan.push({
          numero: compte.numero,
          nom: compte.nom,
          solde: solde
        });
      }
    });

    const resultatNet = totalProduits - totalCharges;

    res.json({
      annee: parseInt(annee),
      comptesResultat: {
        charges: comptesResultat.charges.sort((a, b) => a.numero.localeCompare(b.numero)),
        produits: comptesResultat.produits.sort((a, b) => a.numero.localeCompare(b.numero)),
        totalCharges,
        totalProduits
      },
      resultatNet,
      typeResultat: resultatNet >= 0 ? 'benefice' : 'perte',
      compteResultat: resultatNet >= 0 ? '120' : '129',
      comptesBilan: comptesBilan.sort((a, b) => a.numero.localeCompare(b.numero)),
      message: resultatNet >= 0 
        ? `Bénéfice de ${resultatNet.toLocaleString('fr-FR')} FCFA à reporter sur le compte 120`
        : `Perte de ${Math.abs(resultatNet).toLocaleString('fr-FR')} FCFA à reporter sur le compte 129`
    });
  } catch (error) {
    console.error('Erreur preview clôture:', error);
    res.status(500).json({ error: error.message });
  }
});

// Exécution de la clôture d'exercice
router.post('/cloture-exercice', async (req, res) => {
  try {
    const entrepriseId = req.entrepriseId;
    const { annee } = req.body;

    if (!entrepriseId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }
    if (!annee) {
      return res.status(400).json({ error: 'Année requise' });
    }

    const dateDebut = `${annee}-01-01`;
    const dateFin = `${annee}-12-31`;
    const dateClotureStr = `${annee}-12-31`;
    const dateOuvertureStr = `${parseInt(annee) + 1}-01-01`;

    // Récupérer tous les comptes
    const comptesData = await db.query.comptesComptables.findMany({
      where: eq(comptesComptables.entrepriseId, entrepriseId)
    });

    const comptesMap = {};
    comptesData.forEach(c => {
      comptesMap[c.numero] = c;
    });

    // Récupérer les écritures de l'exercice
    const ecrituresData = await db
      .select({ id: ecritures.id })
      .from(ecritures)
      .where(and(
        eq(ecritures.entrepriseId, entrepriseId),
        gte(ecritures.dateEcriture, new Date(dateDebut)),
        lte(ecritures.dateEcriture, new Date(dateFin))
      ));

    const ecritureIds = ecrituresData.map(e => e.id);
    const ecritureIdsSet = new Set(ecritureIds);

    // Calculer les soldes par compte
    const soldesMap = {};
    const lignesExercice = await db
      .select({
        compteComptableId: lignesEcritures.compteComptableId,
        debit: lignesEcritures.debit,
        credit: lignesEcritures.credit,
        ecritureId: lignesEcritures.ecritureId
      })
      .from(lignesEcritures)
      .where(eq(lignesEcritures.entrepriseId, entrepriseId));

    lignesExercice.forEach(l => {
      if (ecritureIdsSet.has(l.ecritureId)) {
        const compteId = l.compteComptableId;
        if (!soldesMap[compteId]) soldesMap[compteId] = 0;
        soldesMap[compteId] += parseFloat(l.debit || 0) - parseFloat(l.credit || 0);
      }
    });

    // Séparer les comptes - Conserver le signe réel du solde
    // Solde = Débit - Crédit
    // Charges (classe 6): normalement solde positif (débiteur)
    // Produits (classe 7): normalement solde négatif (créditeur)
    let totalCharges = 0;
    let totalProduits = 0;
    const comptesResultat = []; // Tous les comptes de résultat avec leur solde réel
    const comptesBilan = [];

    comptesData.forEach(compte => {
      const solde = soldesMap[compte.id] || 0;
      if (solde === 0) return;

      const classe = compte.numero.charAt(0);

      if (classe === '6' || classe === '7') {
        // Comptes de résultat - conserver le signe réel
        comptesResultat.push({ compte, solde });
        if (classe === '6') {
          // Charges: solde positif = débit, donc on ajoute à totalCharges
          totalCharges += solde > 0 ? solde : 0;
          totalProduits += solde < 0 ? Math.abs(solde) : 0; // Charge créditeur exceptionnel = produit
        } else {
          // Produits: solde négatif = crédit, donc on prend la valeur absolue
          totalProduits += solde < 0 ? Math.abs(solde) : 0;
          totalCharges += solde > 0 ? solde : 0; // Produit débiteur exceptionnel = charge
        }
      } else if (['1', '2', '3', '4', '5'].includes(classe)) {
        comptesBilan.push({ compte, solde });
      }
    });

    const resultatNet = totalProduits - totalCharges;
    const estBenefice = resultatNet >= 0;
    const compteResultatNumero = estBenefice ? '120' : '129';

    // Récupérer le journal OD (Opérations Diverses)
    const journalOD = await db.query.journaux.findFirst({
      where: and(
        eq(journaux.entrepriseId, entrepriseId),
        eq(journaux.code, 'OD')
      )
    });

    if (!journalOD) {
      return res.status(400).json({ error: 'Journal OD non trouvé' });
    }

    // Récupérer le journal AN (À Nouveau)
    const journalAN = await db.query.journaux.findFirst({
      where: and(
        eq(journaux.entrepriseId, entrepriseId),
        eq(journaux.code, 'AN')
      )
    });

    if (!journalAN) {
      return res.status(400).json({ error: 'Journal AN non trouvé' });
    }

    // Vérifier/créer le compte de résultat
    let compteResultat = comptesMap[compteResultatNumero];
    if (!compteResultat) {
      const [newCompte] = await db.insert(comptesComptables).values({
        entrepriseId,
        numero: compteResultatNumero,
        nom: estBenefice ? "Résultat de l'exercice (bénéfice)" : "Résultat de l'exercice (perte)",
        type: 'detail',
        categorie: 'Capitaux propres',
        actif: true
      }).returning();
      compteResultat = newCompte;
    }

    // ==========================================
    // 1. ÉCRITURE DE CLÔTURE DES COMPTES DE RÉSULTAT
    // ==========================================
    const numeroEcritureCloture = `CLO-${annee}-001`;
    
    const [ecritureCloture] = await db.insert(ecritures).values({
      entrepriseId,
      journalId: journalOD.id,
      numeroEcriture: numeroEcritureCloture,
      dateEcriture: new Date(dateClotureStr),
      libelle: `Clôture des comptes de résultat exercice ${annee}`,
      numeroPiece: `CLOTURE-${annee}`,
      valide: true
    }).returning();

    const lignesCloture = [];
    let totalDebitCloture = 0;
    let totalCreditCloture = 0;

    // Solder tous les comptes de résultat en inversant leur solde
    // Si solde > 0 (débiteur), on crédite pour solder
    // Si solde < 0 (créditeur), on débite pour solder
    for (const { compte, solde } of comptesResultat) {
      if (solde > 0) {
        // Solde débiteur → crédit pour solder
        lignesCloture.push({
          entrepriseId,
          ecritureId: ecritureCloture.id,
          compteComptableId: compte.id,
          debit: '0',
          credit: solde.toString(),
          libelle: `Solde compte ${compte.numero} - ${compte.nom}`
        });
        totalCreditCloture += solde;
      } else {
        // Solde créditeur → débit pour solder
        lignesCloture.push({
          entrepriseId,
          ecritureId: ecritureCloture.id,
          compteComptableId: compte.id,
          debit: Math.abs(solde).toString(),
          credit: '0',
          libelle: `Solde compte ${compte.numero} - ${compte.nom}`
        });
        totalDebitCloture += Math.abs(solde);
      }
    }

    // Reporter le résultat sur le compte 120 ou 129
    // Le résultat équilibre l'écriture de clôture
    const differenceResultat = totalCreditCloture - totalDebitCloture;
    if (differenceResultat >= 0) {
      // Plus de crédits que de débits = bénéfice → débit du résultat pour équilibrer
      lignesCloture.push({
        entrepriseId,
        ecritureId: ecritureCloture.id,
        compteComptableId: compteResultat.id,
        debit: differenceResultat.toString(),
        credit: '0',
        libelle: `Résultat de l'exercice ${annee}`
      });
      totalDebitCloture += differenceResultat;
    } else {
      // Plus de débits que de crédits = perte → crédit du résultat pour équilibrer
      lignesCloture.push({
        entrepriseId,
        ecritureId: ecritureCloture.id,
        compteComptableId: compteResultat.id,
        debit: '0',
        credit: Math.abs(differenceResultat).toString(),
        libelle: `Résultat de l'exercice ${annee}`
      });
      totalCreditCloture += Math.abs(differenceResultat);
    }

    // Validation: l'écriture de clôture doit être équilibrée
    if (Math.abs(totalDebitCloture - totalCreditCloture) > 0.01) {
      throw new Error(`Écriture de clôture non équilibrée: Débit=${totalDebitCloture}, Crédit=${totalCreditCloture}`);
    }

    // Insérer les lignes de clôture
    await db.insert(lignesEcritures).values(lignesCloture);

    // ==========================================
    // 2. ÉCRITURE D'OUVERTURE DU NOUVEL EXERCICE
    // ==========================================
    const numeroEcritureOuverture = `AN-${parseInt(annee) + 1}-001`;

    // Calculer les nouveaux soldes de bilan (incluant le résultat)
    const soldesBilanFinaux = {};
    comptesBilan.forEach(({ compte, solde }) => {
      soldesBilanFinaux[compte.id] = { compte, solde };
    });

    // Ajouter le résultat au bilan
    // Le compte de résultat (120 ou 129) a été mouvementé dans l'écriture de clôture
    // Pour le bilan d'ouverture, on reporte ce solde
    if (compteResultat) {
      if (!soldesBilanFinaux[compteResultat.id]) {
        soldesBilanFinaux[compteResultat.id] = { compte: compteResultat, solde: 0 };
      }
      // Dans l'écriture de clôture:
      // - Si differenceResultat >= 0 (crédits > débits = produits > charges = bénéfice):
      //   On a DÉBITÉ le compte résultat pour équilibrer
      //   Le compte 120 (bénéfice) doit apparaître au CRÉDIT du passif dans le bilan
      //   Donc pour le report, on ajoute un solde NÉGATIF (créditeur)
      // - Si differenceResultat < 0 (débits > crédits = charges > produits = perte):
      //   On a CRÉDITÉ le compte résultat pour équilibrer
      //   Le compte 129 (perte) doit apparaître au DÉBIT de l'actif dans le bilan
      //   Donc pour le report, on ajoute un solde POSITIF (débiteur)
      // 
      // Dans les deux cas: solde_report = -differenceResultat
      // Car si on a débité dans la clôture, le report est créditeur (passif)
      // Et si on a crédité dans la clôture, le report est débiteur (actif)
      soldesBilanFinaux[compteResultat.id].solde += differenceResultat;
    }

    const [ecritureOuverture] = await db.insert(ecritures).values({
      entrepriseId,
      journalId: journalAN.id,
      numeroEcriture: numeroEcritureOuverture,
      dateEcriture: new Date(dateOuvertureStr),
      libelle: `Bilan d'ouverture exercice ${parseInt(annee) + 1}`,
      numeroPiece: `OUVERTURE-${parseInt(annee) + 1}`,
      valide: true
    }).returning();

    const lignesOuverture = [];
    let totalDebitOuverture = 0;
    let totalCreditOuverture = 0;

    Object.values(soldesBilanFinaux).forEach(({ compte, solde }) => {
      if (solde === 0) return;

      if (solde > 0) {
        // Solde débiteur
        lignesOuverture.push({
          entrepriseId,
          ecritureId: ecritureOuverture.id,
          compteComptableId: compte.id,
          debit: solde.toString(),
          credit: '0',
          libelle: `Report à nouveau ${compte.numero}`
        });
        totalDebitOuverture += solde;
      } else {
        // Solde créditeur
        lignesOuverture.push({
          entrepriseId,
          ecritureId: ecritureOuverture.id,
          compteComptableId: compte.id,
          debit: '0',
          credit: Math.abs(solde).toString(),
          libelle: `Report à nouveau ${compte.numero}`
        });
        totalCreditOuverture += Math.abs(solde);
      }
    });

    // Validation: l'écriture d'ouverture doit être équilibrée
    if (Math.abs(totalDebitOuverture - totalCreditOuverture) > 1) {
      throw new Error(`Écriture d'ouverture non équilibrée: Débit=${totalDebitOuverture.toLocaleString('fr-FR')}, Crédit=${totalCreditOuverture.toLocaleString('fr-FR')}`);
    }

    // Insérer les lignes d'ouverture
    if (lignesOuverture.length > 0) {
      await db.insert(lignesEcritures).values(lignesOuverture);
    }

    // Enregistrer dans l'audit log
    await db.insert(auditLogs).values({
      entrepriseId,
      userId: req.userId,
      action: 'CLOTURE_EXERCICE',
      entite: 'exercice',
      entiteId: annee.toString(),
      details: JSON.stringify({
        annee,
        resultatNet,
        typeResultat: estBenefice ? 'benefice' : 'perte',
        compteResultat: compteResultatNumero,
        ecritureCloture: numeroEcritureCloture,
        ecritureOuverture: numeroEcritureOuverture
      })
    });

    res.json({
      success: true,
      message: `Exercice ${annee} clôturé avec succès`,
      details: {
        resultatNet,
        typeResultat: estBenefice ? 'benefice' : 'perte',
        compteResultat: compteResultatNumero,
        ecritureCloture: {
          numero: numeroEcritureCloture,
          lignes: lignesCloture.length
        },
        ecritureOuverture: {
          numero: numeroEcritureOuverture,
          lignes: lignesOuverture.length,
          totalDebit: totalDebitOuverture,
          totalCredit: totalCreditOuverture
        }
      }
    });
  } catch (error) {
    console.error('Erreur clôture exercice:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
