import express from 'express';
import { db } from '../db.js';
import {
  auditLogs,
  comptesComptables,
  ecritures,
  journaux,
  lignesEcritures,
} from '../schema.js';
import { and, eq, gte, like, lte } from 'drizzle-orm';

// Clôture d'exercice (ComptaOrioLite) — extrait verbatim de
// routes/comptabilite.js, qui n'est pas monté dans app.js. Ce routeur est
// monté dans app.js sous /api, donc :
//   GET  /api/cloture-exercice/preview?annee=2025
//   POST /api/cloture-exercice { annee }
// Lite est services uniquement : la clôture ne touche que le grand livre
// (comptes, écritures, lignes, journaux OD/AN, audit) — aucune table de
// stock, aucun achat, aucune TVA. Le résultat est reporté en 120 (bénéfice)
// ou 129 (perte) et le bilan d'ouverture AN-{année+1} reprend les soldes.
// Réouverture (POST /api/cloture-exercice/:annee/reouverture) : contrepasse
// la clôture et l'ouverture (mêmes montants, sens inversés), comme
// ComptaOrion. Garde contre la double clôture : un exercice déjà clôturé
// (et non réouvert) est refusé en 409 ; après réouverture, une nouvelle
// clôture est autorisée avec le numéro de séquence suivant (CLO-...-002).
// Lite n'a pas de table clotures_exercices : l'état (clôturé / réouvert)
// est déduit des écritures elles-mêmes (numéro CLO-... et contrepassation
// REOUVERTURE-CLOTURE-...).

const router = express.Router();

// ==========================================
// AIDES — ÉTAT DE CLÔTURE ET NUMÉROTATION
// ==========================================

// Extrait la séquence numérique d'un numéro d'écriture (ex. CLO-2025-001
// → 1). Retourne null si le numéro n'est pas de la forme PREFIXE-AAAA-NNN
// (les contrepassations CLO-...-001-R sont donc ignorées).
function sequenceDepuisNumero(numero, prefixe, annee) {
  const m = new RegExp(`^${prefixe}-(\\d{4})-(\\d+)$`).exec(numero || '');
  if (!m || Number(m[1]) !== Number(annee)) return null;
  return Number(m[2]);
}

// Charge les écritures de clôture (CLO-{annee}-*) et d'ouverture
// (AN-{annee+1}-*) de l'entreprise, y compris les contrepassations.
async function chargerEcrituresCloture(db, entrepriseId, annee) {
  const entreesClo = await db.select().from(ecritures).where(and(
    eq(ecritures.entrepriseId, entrepriseId),
    like(ecritures.numeroEcriture, `CLO-${annee}-%`)
  ));
  const entreesAn = await db.select().from(ecritures).where(and(
    eq(ecritures.entrepriseId, entrepriseId),
    like(ecritures.numeroEcriture, `AN-${parseInt(annee) + 1}-%`)
  ));
  return { entreesClo, entreesAn };
}

// Analyse les écritures de clôture d'un exercice : retrouve la dernière
// clôture (séquence la plus haute) et indique si elle a été contrepassée
// (réouverte). Retourne { derniere, sequence, estContrepassee }.
function analyserCloture(entreesClo, annee) {
  let derniere = null;
  let sequence = 0;
  for (const e of entreesClo || []) {
    const seq = sequenceDepuisNumero(e.numeroEcriture, 'CLO', annee);
    if (seq !== null && seq > sequence) {
      sequence = seq;
      derniere = e;
    }
  }
  if (!derniere) return { derniere: null, sequence: 0, estContrepassee: false };
  const suffixe = String(sequence).padStart(3, '0');
  const estContrepassee = (entreesClo || []).some((e) =>
    e.numeroPiece === `REOUVERTURE-CLOTURE-${annee}-R${sequence}` ||
    e.numeroEcriture === `CLO-${annee}-${suffixe}-R`
  );
  return { derniere, sequence, estContrepassee };
}

// Prochaine séquence à utiliser pour une (ré-)clôture : la plus haute
// séquence déjà utilisée (clôture ou ouverture, même contrepassée) + 1.
// Première clôture → 1 ; après réouverture d'une clôture -001 → 2.
function prochaineSequence(entreesClo, entreesAn, annee) {
  let max = 0;
  for (const e of entreesClo || []) {
    const seq = sequenceDepuisNumero(e.numeroEcriture, 'CLO', annee);
    if (seq !== null) max = Math.max(max, seq);
  }
  for (const e of entreesAn || []) {
    const seq = sequenceDepuisNumero(e.numeroEcriture, 'AN', parseInt(annee) + 1);
    if (seq !== null) max = Math.max(max, seq);
  }
  return max + 1;
}

// Inverse les lignes d'une écriture (débit ↔ crédit) pour une contrepassation.
function lignesInversees(lignes, ecritureId, entrepriseId) {
  return (lignes || []).map((l) => ({
    entrepriseId,
    ecritureId,
    compteComptableId: l.compteComptableId,
    debit: l.credit || '0',
    credit: l.debit || '0',
    libelle: `Contrepassation - ${l.libelle || ''}`.trim()
  }));
}

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

    // Garde contre la double clôture : un exercice déjà clôturé (et non
    // réouvert) ne peut pas être clôturé une seconde fois.
    const { entreesClo, entreesAn } = await chargerEcrituresCloture(db, entrepriseId, annee);
    const { derniere: derniereCloture, estContrepassee } = analyserCloture(entreesClo, annee);
    if (derniereCloture && !estContrepassee) {
      return res.status(409).json({ error: `Exercice ${annee} déjà clôturé` });
    }
    // Numérotation : 001 pour la première clôture, séquence suivante après
    // une réouverture (la clôture -001, même contrepassée, ne doit pas être
    // réutilisée).
    const sequence = prochaineSequence(entreesClo, entreesAn, annee);
    const suffixe = String(sequence).padStart(3, '0');
    const numeroEcritureCloture = `CLO-${annee}-${suffixe}`;
    const numeroEcritureOuverture = `AN-${parseInt(annee) + 1}-${suffixe}`;
    const numeroPieceCloture = sequence > 1 ? `CLOTURE-${annee}-${sequence}` : `CLOTURE-${annee}`;
    const numeroPieceOuverture = sequence > 1 ? `OUVERTURE-${parseInt(annee) + 1}-${sequence}` : `OUVERTURE-${parseInt(annee) + 1}`;

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
    const [ecritureCloture] = await db.insert(ecritures).values({
      entrepriseId,
      journalId: journalOD.id,
      numeroEcriture: numeroEcritureCloture,
      dateEcriture: new Date(dateClotureStr),
      libelle: `Clôture des comptes de résultat exercice ${annee}`,
      numeroPiece: numeroPieceCloture,
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
      numeroPiece: numeroPieceOuverture,
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

// ==========================================
// RÉOUVERTURE D'EXERCICE
// ==========================================

// Réouverture d'un exercice clôturé : contrepasse l'écriture de clôture
// et l'écriture d'ouverture (mêmes montants, sens inversés), comme
// ComptaOrion (route POST /cloture-exercice/:annee/reouverture). Les deux
// contrepassations sont créées en une seule transaction. Après réouverture,
// une nouvelle clôture du même exercice est autorisée (séquence suivante).
router.post('/cloture-exercice/:annee/reouverture', async (req, res) => {
  try {
    const entrepriseId = req.entrepriseId;
    const { annee } = req.params;
    const motif = String(req.body?.motif || '').trim();

    if (!entrepriseId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }
    if (!annee) {
      return res.status(400).json({ error: 'Année requise' });
    }
    if (motif.length < 10 || motif.length > 500) {
      return res.status(400).json({ error: 'Indiquez un motif de réouverture de 10 à 500 caractères.' });
    }

    const dateClotureStr = `${annee}-12-31`;
    const dateOuvertureStr = `${parseInt(annee) + 1}-01-01`;

    // Retrouver la dernière clôture de l'exercice
    const { entreesClo, entreesAn } = await chargerEcrituresCloture(db, entrepriseId, annee);
    const { derniere, sequence, estContrepassee } = analyserCloture(entreesClo, annee);
    if (!derniere) {
      return res.status(404).json({ error: `L'exercice ${annee} n'a jamais été clôturé.` });
    }
    if (estContrepassee) {
      return res.status(409).json({ error: `L'exercice ${annee} a déjà été réouvert.` });
    }

    // Retrouver l'écriture d'ouverture de la même séquence
    const suffixe = String(sequence).padStart(3, '0');
    const numeroOuverture = `AN-${parseInt(annee) + 1}-${suffixe}`;
    const ouverture = (entreesAn || []).find((e) => e.numeroEcriture === numeroOuverture);
    if (!ouverture) {
      return res.status(500).json({ error: `Écriture d'ouverture ${numeroOuverture} introuvable : clôture incohérente.` });
    }

    // Charger les lignes des deux écritures à contrepasser
    const lignesCloture = await db.select().from(lignesEcritures)
      .where(eq(lignesEcritures.ecritureId, derniere.id));
    const lignesOuverture = await db.select().from(lignesEcritures)
      .where(eq(lignesEcritures.ecritureId, ouverture.id));

    // Journaux OD et AN
    const journalOD = await db.query.journaux.findFirst({
      where: and(
        eq(journaux.entrepriseId, entrepriseId),
        eq(journaux.code, 'OD')
      )
    });
    if (!journalOD) {
      return res.status(400).json({ error: 'Journal OD non trouvé' });
    }
    const journalAN = await db.query.journaux.findFirst({
      where: and(
        eq(journaux.entrepriseId, entrepriseId),
        eq(journaux.code, 'AN')
      )
    });
    if (!journalAN) {
      return res.status(400).json({ error: 'Journal AN non trouvé' });
    }

    const numeroContrepassationCloture = `CLO-${annee}-${suffixe}-R`;
    const numeroContrepassationOuverture = `AN-${parseInt(annee) + 1}-${suffixe}-R`;

    await db.transaction(async (tx) => {
      // 1. Contrepassation de la clôture (mêmes montants, sens inversés)
      const [contreCloture] = await tx.insert(ecritures).values({
        entrepriseId,
        journalId: journalOD.id,
        numeroEcriture: numeroContrepassationCloture,
        dateEcriture: new Date(dateClotureStr),
        libelle: `Contrepassation de la clôture de l'exercice ${annee}`,
        numeroPiece: `REOUVERTURE-CLOTURE-${annee}-R${sequence}`,
        valide: true
      }).returning();
      const lignesContreCloture = lignesInversees(lignesCloture, contreCloture.id, entrepriseId);
      if (lignesContreCloture.length > 0) {
        await tx.insert(lignesEcritures).values(lignesContreCloture);
      }

      // 2. Contrepassation de l'ouverture (mêmes montants, sens inversés)
      const [contreOuverture] = await tx.insert(ecritures).values({
        entrepriseId,
        journalId: journalAN.id,
        numeroEcriture: numeroContrepassationOuverture,
        dateEcriture: new Date(dateOuvertureStr),
        libelle: `Contrepassation de l'ouverture de l'exercice ${parseInt(annee) + 1}`,
        numeroPiece: `REOUVERTURE-OUVERTURE-${annee}-R${sequence}`,
        valide: true
      }).returning();
      const lignesContreOuverture = lignesInversees(lignesOuverture, contreOuverture.id, entrepriseId);
      if (lignesContreOuverture.length > 0) {
        await tx.insert(lignesEcritures).values(lignesContreOuverture);
      }

      // 3. Audit
      await tx.insert(auditLogs).values({
        entrepriseId,
        userId: req.userId,
        action: 'REOUVERTURE_EXERCICE',
        tableName: 'ecritures',
        recordId: derniere.id,
        description: `Réouverture de l'exercice ${annee}: ${motif}`,
        nouvelleValeur: JSON.stringify({
          annee,
          motif,
          sequence,
          ecritureContrepassationCloture: numeroContrepassationCloture,
          ecritureContrepassationOuverture: numeroContrepassationOuverture
        })
      });
    });

    res.json({
      success: true,
      message: `Exercice ${annee} réouvert. Les écritures de clôture et d'ouverture ont été contrepassées.`,
      details: {
        exercice: parseInt(annee),
        sequence,
        motif,
        ecritureContrepassationCloture: numeroContrepassationCloture,
        ecritureContrepassationOuverture: numeroContrepassationOuverture
      }
    });
  } catch (error) {
    console.error('Erreur réouverture exercice:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
