import express from 'express';
import { db } from '../db.js';
import { factures, paiements, facturesAchat, paiementsFournisseurs, stockParEntrepot, produits, mouvementsStock, factureItems, entreprises } from '../schema.js';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';

const router = express.Router();

// Fonction utilitaire pour obtenir dates de l'année fiscale par défaut (année civile)
function getDefaultFiscalYearDates() {
  const now = new Date();
  const debut = new Date(now.getFullYear(), 0, 1); // 1er janvier
  const fin = new Date(now.getFullYear(), 11, 31); // 31 décembre
  return { debut, fin };
}

// Fonction pour obtenir l'année fiscale de l'entreprise
async function getFiscalYearDatesForEntreprise(entrepriseId) {
  try {
    const entreprise = await db.query.entreprises.findFirst({
      where: eq(entreprises.id, entrepriseId)
    });
    
    if (entreprise && entreprise.debutAnneeFiscale && entreprise.finAnneeFiscale) {
      return {
        debut: new Date(entreprise.debutAnneeFiscale),
        fin: new Date(entreprise.finAnneeFiscale)
      };
    }
  } catch (error) {
    console.error('Erreur récupération année fiscale:', error.message);
  }
  
  // Fallback: année civile courante
  return getDefaultFiscalYearDates();
}

// Fonction utilitaire pour obtenir dates du mois
function getMonthDates() {
  const now = new Date();
  const debut = new Date(now.getFullYear(), now.getMonth(), 1);
  const fin = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { debut, fin };
}

// Dashboard global - tous les KPIs
router.get('/global', async (req, res) => {
  try {
    const { dateDebut, dateFin, startDate, endDate } = req.query;
    const eId = req.entrepriseId;
    
    if (!eId) {
      return res.status(401).json({ error: 'Authentification requise' });
    }
    
    // Par défaut: année fiscale de l'entreprise
    const { debut, fin } = await getFiscalYearDatesForEntreprise(eId);
    const dateStart = dateDebut ? new Date(dateDebut) : (startDate ? new Date(startDate) : debut);
    const dateEnd = dateFin ? new Date(dateFin) : (endDate ? new Date(endDate) : fin);

    // Ventes du mois (factures payées/envoyées)
    const ventesData = await db.query.factures.findMany({
      where: and(
        eq(factures.entrepriseId, eId),
        gte(factures.createdAt, dateStart),
        lte(factures.createdAt, dateEnd)
      )
    });
    const ventesMois = ventesData.reduce((sum, f) => sum + parseFloat(f.totalTTC || 0), 0);

    // Dépenses du mois (factures fournisseurs)
    const depensesData = await db.query.facturesAchat.findMany({
      where: and(
        eq(facturesAchat.entrepriseId, eId),
        gte(facturesAchat.createdAt, dateStart),
        lte(facturesAchat.createdAt, dateEnd)
      )
    });
    const depensesMois = depensesData.reduce((sum, f) => sum + parseFloat(f.totalTTC || 0), 0);

    // Factures en retard (statut = 'retard') - dans la période sélectionnée
    const factulesRetard = await db.query.factures.findMany({
      where: and(
        eq(factures.entrepriseId, eId),
        eq(factures.statut, 'retard'),
        gte(factures.createdAt, dateStart),
        lte(factures.createdAt, dateEnd)
      )
    });
    const facturesRetardTotal = factulesRetard.length;
    const montantRetard = factulesRetard.reduce((sum, f) => sum + parseFloat(f.totalTTC || 0), 0);

    // Stock faible (quantité < seuil minimum)
    const stockFaible = await db.query.produits.findMany({
      where: eq(produits.entrepriseId, eId)
    });
    const produitsFaibles = stockFaible.filter(p => {
      return parseFloat(p.quantite || 0) < parseFloat(p.stockMinimum || 0);
    });

    // Calcul du Coût des Marchandises Vendues (CMV)
    // Méthode 1: À partir des lignes de factures (si disponibles)
    // Méthode 2: Estimation basée sur les achats de la période (fallback)
    const facturesIds = ventesData.map(f => f.id);
    let cmv = 0;
    let cmvMethode = 'lignes_factures';
    
    if (facturesIds.length > 0) {
      // Récupérer tous les produits pour avoir leurs prix d'achat
      const produitsMap = {};
      const allProduits = await db.query.produits.findMany({
        where: eq(produits.entrepriseId, eId)
      });
      allProduits.forEach(p => { produitsMap[p.id] = parseFloat(p.prixAchat || 0); });
      
      // Calculer le CMV à partir des lignes de factures (requête sécurisée)
      const itemsResult = await db
        .select({
          produitId: factureItems.produitId,
          quantite: factureItems.quantite,
          prixUnitaire: factureItems.prixUnitaire
        })
        .from(factureItems)
        .where(
          and(
            eq(factureItems.entrepriseId, eId),
            sql`${factureItems.factureId} IN (${sql.join(facturesIds.map(id => sql`${id}`), sql`, `)})`
          )
        );
      
      (itemsResult || []).forEach(item => {
        const prixAchat = produitsMap[item.produitId] || 0;
        const quantite = parseFloat(item.quantite || 0);
        cmv += quantite * prixAchat;
      });
    }

    // Si CMV = 0, utiliser les achats (factures fournisseurs) comme estimation
    if (cmv === 0 && depensesMois > 0) {
      // Utiliser le total HT des achats comme approximation du CMV
      cmv = depensesData.reduce((sum, f) => sum + parseFloat(f.totalHT || f.totalTTC * 0.82 || 0), 0);
      cmvMethode = 'achats_periode';
    }

    // Marge brute = (Ventes HT - CMV) / Ventes HT × 100
    const ventesHT = ventesData.reduce((sum, f) => sum + parseFloat(f.totalHT || f.totalTTC * 0.82 || 0), 0);
    
    // Calculer la marge brute (limiter entre 0 et 100% pour éviter les valeurs aberrantes)
    let margeBrute = 0;
    if (ventesHT > 0 && cmv > 0) {
      margeBrute = Math.max(0, Math.min(100, ((ventesHT - cmv) / ventesHT * 100))).toFixed(2);
    } else if (ventesHT > 0 && cmv === 0) {
      // Pas de données CMV fiables - afficher N/A ou estimation
      margeBrute = null; // Sera affiché comme "N/A" sur le frontend
    }

    // Cashflow = Ventes - Dépenses
    const cashflow = ventesMois - depensesMois;

    // =====================
    // CALCUL DES KPIs CYCLE DE TRÉSORERIE
    // =====================
    
    // DSO (Days Sales Outstanding) - Délai moyen de paiement clients
    // Utilise la DERNIÈRE date de paiement pour les factures avec paiements multiples
    const paiementsClients = await db.query.paiements.findMany({
      where: eq(paiements.entrepriseId, eId)
    });
    
    // Grouper les paiements par facture et prendre la dernière date
    const dernierPaiementClient = {};
    paiementsClients.forEach(p => {
      if (p.factureId && p.datePaiement) {
        const datePaiement = new Date(p.datePaiement);
        if (!dernierPaiementClient[p.factureId] || datePaiement > dernierPaiementClient[p.factureId]) {
          dernierPaiementClient[p.factureId] = datePaiement;
        }
      }
    });
    
    let dsoTotal = 0, dsoCount = 0;
    ventesData.forEach(f => {
      const dernierePaiementDate = dernierPaiementClient[f.id];
      if (dernierePaiementDate) {
        const dateFacture = new Date(f.dateFacture || f.createdAt);
        const delai = (dernierePaiementDate - dateFacture) / (1000 * 60 * 60 * 24);
        if (delai > 0) { dsoTotal += delai; dsoCount++; }
      }
    });
    const dso = dsoCount > 0 ? Math.round(dsoTotal / dsoCount) : 0;
    
    // DPO (Days Payable Outstanding) - Délai moyen de paiement fournisseurs
    // Utilise la DERNIÈRE date de paiement pour les factures avec paiements multiples
    const paiementsFourn = await db.query.paiementsFournisseurs.findMany({
      where: eq(paiementsFournisseurs.entrepriseId, eId)
    });
    
    // Grouper les paiements par facture et prendre la dernière date
    const dernierPaiementFourn = {};
    paiementsFourn.forEach(p => {
      if (p.factureId && p.datePaiement) {
        const datePaiement = new Date(p.datePaiement);
        if (!dernierPaiementFourn[p.factureId] || datePaiement > dernierPaiementFourn[p.factureId]) {
          dernierPaiementFourn[p.factureId] = datePaiement;
        }
      }
    });
    
    let dpoTotal = 0, dpoCount = 0;
    depensesData.forEach(f => {
      const dernierePaiementDate = dernierPaiementFourn[f.id];
      if (dernierePaiementDate) {
        const dateFacture = new Date(f.dateFacture || f.createdAt);
        const delai = (dernierePaiementDate - dateFacture) / (1000 * 60 * 60 * 24);
        if (delai > 0) { dpoTotal += delai; dpoCount++; }
      }
    });
    const dpo = dpoCount > 0 ? Math.round(dpoTotal / dpoCount) : 0;
    
    // DIO (Days Inventory Outstanding) - Rotation des stocks
    // DIO = (Stock moyen / CMV) × nombre de jours de la période
    const stockActuel = await db.query.produits.findMany({
      where: eq(produits.entrepriseId, eId)
    });
    const valeurStockActuel = stockActuel.reduce((sum, p) => {
      return sum + (parseFloat(p.quantite || 0) * parseFloat(p.prixAchat || 0));
    }, 0);
    const nombreJours = Math.ceil((dateEnd - dateStart) / (1000 * 60 * 60 * 24)) || 30;
    const dio = cmv > 0 ? Math.round((valeurStockActuel / cmv) * nombreJours) : 0;
    
    // CCC (Cash Conversion Cycle) - Cycle de conversion de trésorerie
    // CCC = DSO + DIO - DPO
    const ccc = dso + dio - dpo;

    res.json({
      ventesMois: parseFloat(ventesMois).toFixed(2),
      depensesMois: parseFloat(depensesMois).toFixed(2),
      facturesEnRetard: {
        nombre: facturesRetardTotal,
        montant: parseFloat(montantRetard).toFixed(2)
      },
      stockFaible: {
        nombre: produitsFaibles.length,
        produits: produitsFaibles.slice(0, 5)
      },
      margeBrute: margeBrute !== null ? parseFloat(margeBrute) : null,
      cmv: Math.round(cmv),
      ventesHT: Math.round(ventesHT),
      cashflow: parseFloat(cashflow).toFixed(2),
      dateRange: { debut: dateStart, fin: dateEnd },
      // KPIs du cycle de trésorerie
      dso, // Délai paiement clients (jours)
      dpo, // Délai paiement fournisseurs (jours)
      dio, // Rotation stock (jours)
      ccc, // Cycle de conversion trésorerie (jours)
      valeurStock: Math.round(valeurStockActuel)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ventes par mois (dans la période sélectionnée)
router.get('/ventes-mensuelles', async (req, res) => {
  try {
    const eId = req.entrepriseId;
    if (!eId) return res.status(400).json({ error: 'entrepriseId requis' });
    
    const { dateDebut, dateFin } = req.query;
    const { debut: defaultDebut, fin: defaultFin } = await getFiscalYearDatesForEntreprise(eId);
    const periodStart = dateDebut ? new Date(dateDebut) : defaultDebut;
    const periodEnd = dateFin ? new Date(dateFin) : defaultFin;
    
    const data = [];
    const current = new Date(periodStart.getFullYear(), periodStart.getMonth(), 1);
    
    while (current <= periodEnd) {
      const debut = new Date(current.getFullYear(), current.getMonth(), 1);
      const fin = new Date(current.getFullYear(), current.getMonth() + 1, 0);
      
      if (fin > periodEnd) {
        fin.setTime(periodEnd.getTime());
      }

      const ventes = await db.query.factures.findMany({
        where: and(
          eq(factures.entrepriseId, eId),
          gte(factures.createdAt, debut),
          lte(factures.createdAt, fin)
        )
      });

      const total = ventes.reduce((sum, f) => sum + parseFloat(f.totalTTC || 0), 0);
      data.push({
        mois: debut.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }),
        ventes: parseFloat(total).toFixed(2)
      });
      
      current.setMonth(current.getMonth() + 1);
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Répartition dépenses par catégorie (dans la période sélectionnée)
router.get('/depenses-categories', async (req, res) => {
  try {
    const eId = req.entrepriseId;
    if (!eId) return res.status(400).json({ error: 'entrepriseId requis' });
    
    const { dateDebut, dateFin } = req.query;
    const { debut: defaultDebut, fin: defaultFin } = await getFiscalYearDatesForEntreprise(eId);
    const periodStart = dateDebut ? new Date(dateDebut) : defaultDebut;
    const periodEnd = dateFin ? new Date(dateFin) : defaultFin;

    const depenses = await db.query.facturesAchat.findMany({
      where: and(
        eq(facturesAchat.entrepriseId, eId),
        gte(facturesAchat.createdAt, periodStart),
        lte(facturesAchat.createdAt, periodEnd)
      )
    });

    // Grouper par fournisseur (comme catégorie)
    const byFournisseur = {};
    depenses.forEach(d => {
      const key = d.fournisseurId || 'Autre';
      byFournisseur[key] = (byFournisseur[key] || 0) + parseFloat(d.totalTTC || 0);
    });

    const data = Object.entries(byFournisseur).map(([id, total]) => ({
      fournisseurId: id,
      total: parseFloat(total).toFixed(2)
    }));

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// KPIs avancés
router.get('/kpis', async (req, res) => {
  try {
    const eId = req.entrepriseId;
    if (!eId) return res.status(400).json({ error: 'entrepriseId requis' });

    // Délai paiement client (jours entre facture et paiement)
    const factulesClients = await db.query.factures.findMany({
      where: eq(factures.entrepriseId, eId)
    });
    const paiementsClients = await db.query.paiements.findMany({
      where: eq(paiements.entrepriseId, eId)
    });

    let delaiClientTotal = 0;
    let delaiClientCount = 0;
    factulesClients.forEach(f => {
      const paiement = paiementsClients.find(p => p.factureId === f.id);
      if (paiement) {
        const delai = (new Date(paiement.datePaiement) - new Date(f.createdAt)) / (1000 * 60 * 60 * 24);
        delaiClientTotal += delai;
        delaiClientCount++;
      }
    });
    const delaiPaiementClient = delaiClientCount > 0 ? (delaiClientTotal / delaiClientCount).toFixed(0) : 0;

    // Délai paiement fournisseur
    const facturesFournisseurs = await db.query.facturesAchat.findMany({
      where: eq(facturesAchat.entrepriseId, eId)
    });
    const paiementsFournisseurs_data = await db.query.paiementsFournisseurs.findMany({
      where: eq(paiementsFournisseurs.entrepriseId, eId)
    });

    let delaiFournisseurTotal = 0;
    let delaiCount = 0;
    facturesFournisseurs.forEach(f => {
      const paiement = paiementsFournisseurs_data.find(p => p.factureId === f.id);
      if (paiement) {
        const delai = (new Date(paiement.datePaiement) - new Date(f.createdAt)) / (1000 * 60 * 60 * 24);
        delaiFournisseurTotal += delai;
        delaiCount++;
      }
    });
    const delaiPaiementFournisseur = delaiCount > 0 ? (delaiFournisseurTotal / delaiCount).toFixed(0) : 0;

    res.json({
      delaiPaiementClient: parseInt(delaiPaiementClient),
      delaiPaiementFournisseur: parseInt(delaiPaiementFournisseur),
      nombreFacturesEnCours: factulesClients.filter(f => f.statut !== 'payee').length,
      nombreFacturesRetard: factulesClients.filter(f => f.statut === 'retard').length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =====================
// DRILL-DOWN ENDPOINTS
// =====================

// Détail ventes de la période
router.get('/detail/ventes', async (req, res) => {
  try {
    const eId = req.entrepriseId;
    if (!eId || isNaN(eId)) return res.status(400).json({ error: 'entrepriseId requis' });
    
    const { dateDebut, dateFin } = req.query;
    const { debut: defaultDebut, fin: defaultFin } = await getFiscalYearDatesForEntreprise(eId);
    const debut = dateDebut ? new Date(dateDebut) : defaultDebut;
    const fin = dateFin ? new Date(dateFin) : defaultFin;
    
    const ventesData = await db.query.factures.findMany({
      where: and(
        eq(factures.entrepriseId, eId),
        gte(factures.createdAt, debut),
        lte(factures.createdAt, fin)
      ),
      with: { client: true },
      orderBy: [desc(factures.createdAt)]
    });
    
    const result = ventesData.map(f => ({
      id: f.id,
      numero: f.numero,
      dateFacture: f.dateFacture || f.createdAt,
      clientNom: f.client?.nom || f.client?.raisonSociale || 'Client inconnu',
      montantTTC: parseFloat(f.totalTTC || f.montantTTC || 0),
      statut: f.statut
    }));
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Détail dépenses de la période
router.get('/detail/depenses', async (req, res) => {
  try {
    const eId = req.entrepriseId;
    if (!eId || isNaN(eId)) return res.status(400).json({ error: 'entrepriseId requis' });
    
    const { dateDebut, dateFin } = req.query;
    const { debut: defaultDebut, fin: defaultFin } = await getFiscalYearDatesForEntreprise(eId);
    const debut = dateDebut ? new Date(dateDebut) : defaultDebut;
    const fin = dateFin ? new Date(dateFin) : defaultFin;
    
    const depensesData = await db.query.facturesAchat.findMany({
      where: and(
        eq(facturesAchat.entrepriseId, eId),
        gte(facturesAchat.createdAt, debut),
        lte(facturesAchat.createdAt, fin)
      ),
      with: { fournisseur: true },
      orderBy: [desc(facturesAchat.createdAt)]
    });
    
    const result = depensesData.map(f => ({
      id: f.id,
      date: f.dateFacture || f.createdAt,
      description: f.numero || `Facture #${f.id}`,
      categorie: f.fournisseur?.nom || 'Fournisseur',
      montant: parseFloat(f.totalTTC || 0)
    }));
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Détail factures en retard (dans la période sélectionnée)
router.get('/detail/factures-retard', async (req, res) => {
  try {
    const eId = req.entrepriseId;
    if (!eId || isNaN(eId)) return res.status(400).json({ error: 'entrepriseId requis' });
    
    const { dateDebut, dateFin } = req.query;
    const { debut: defaultDebut, fin: defaultFin } = await getFiscalYearDatesForEntreprise(eId);
    const debut = dateDebut ? new Date(dateDebut) : defaultDebut;
    const fin = dateFin ? new Date(dateFin) : defaultFin;
    const now = new Date();
    
    const facturesRetard = await db.query.factures.findMany({
      where: and(
        eq(factures.entrepriseId, eId),
        eq(factures.statut, 'retard'),
        gte(factures.createdAt, debut),
        lte(factures.createdAt, fin)
      ),
      with: { client: true },
      orderBy: [desc(factures.dateEcheance)]
    });
    
    const result = facturesRetard.map(f => {
      const echeance = new Date(f.dateEcheance);
      const joursRetard = Math.max(0, Math.floor((now - echeance) / (1000 * 60 * 60 * 24)));
      return {
        id: f.id,
        numero: f.numero,
        dateFacture: f.dateFacture || f.createdAt,
        clientNom: f.client?.nom || f.client?.raisonSociale || 'Client inconnu',
        dateEcheance: f.dateEcheance,
        joursRetard,
        soldeRestant: parseFloat(f.soldeRestant || f.totalTTC || 0)
      };
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Détail stock faible
// NOTE TECHNIQUE: Le stock faible est un état instantané (quantité actuelle vs seuil minimum).
// Contrairement aux ventes/dépenses qui sont des flux historiques, le stock représente
// toujours l'état ACTUEL de l'inventaire. Le filtrage par période n'a pas de sens sémantique
// pour cette donnée - on veut toujours voir quels produits sont actuellement en rupture,
// peu importe la période fiscale sélectionnée. Les paramètres dateDebut/dateFin sont
// acceptés pour la cohérence API mais ne sont pas appliqués.
router.get('/detail/stock-faible', async (req, res) => {
  try {
    const eId = req.entrepriseId;
    if (!eId || isNaN(eId)) return res.status(400).json({ error: 'entrepriseId requis' });
    
    // Paramètres acceptés pour cohérence API (non utilisés - stock = état actuel)
    const { dateDebut, dateFin } = req.query;
    
    const allProduits = await db.query.produits.findMany({
      where: eq(produits.entrepriseId, eId)
    });
    
    const produitsFaibles = allProduits
      .filter(p => parseFloat(p.quantite || 0) < parseFloat(p.stockMinimum || 0))
      .map(p => ({
        id: p.id,
        reference: p.reference || p.code,
        nom: p.nom || p.designation,
        quantite: parseFloat(p.quantite || 0),
        seuilMin: parseFloat(p.stockMinimum || 0),
        entrepot: p.entrepot || 'Principal'
      }));
    
    res.json(produitsFaibles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Détail cashflow de la période
router.get('/detail/cashflow', async (req, res) => {
  try {
    const eId = req.entrepriseId;
    if (!eId || isNaN(eId)) return res.status(400).json({ error: 'entrepriseId requis' });
    
    const { dateDebut, dateFin } = req.query;
    const { debut: defaultDebut, fin: defaultFin } = await getFiscalYearDatesForEntreprise(eId);
    const debut = dateDebut ? new Date(dateDebut) : defaultDebut;
    const fin = dateFin ? new Date(dateFin) : defaultFin;
    
    // Récupérer paiements clients (entrées)
    const paiementsClients = await db.query.paiements.findMany({
      where: and(
        eq(paiements.entrepriseId, eId),
        gte(paiements.datePaiement, debut),
        lte(paiements.datePaiement, fin)
      ),
      orderBy: [desc(paiements.datePaiement)]
    });
    
    // Récupérer paiements fournisseurs (sorties)
    const paiementsFourn = await db.query.paiementsFournisseurs.findMany({
      where: and(
        eq(paiementsFournisseurs.entrepriseId, eId),
        gte(paiementsFournisseurs.datePaiement, debut),
        lte(paiementsFournisseurs.datePaiement, fin)
      ),
      orderBy: [desc(paiementsFournisseurs.datePaiement)]
    });
    
    // Combiner et trier par date
    const mouvements = [
      ...paiementsClients.map(p => ({
        id: p.id,
        date: p.datePaiement,
        type: 'Encaissement client',
        description: `Paiement ${p.reference || '#' + p.id}`,
        entree: parseFloat(p.montant || 0),
        sortie: 0
      })),
      ...paiementsFourn.map(p => ({
        id: 'f' + p.id,
        date: p.datePaiement,
        type: 'Paiement fournisseur',
        description: `Règlement ${p.reference || '#' + p.id}`,
        entree: 0,
        sortie: parseFloat(p.montant || 0)
      }))
    ].sort((a, b) => new Date(a.date) - new Date(b.date));
    
    // Calculer solde cumulé
    let solde = 0;
    const result = mouvements.map(m => {
      solde += m.entree - m.sortie;
      return { ...m, solde };
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Drill-down: Marge brute détaillée
router.get('/detail/marge', async (req, res) => {
  try {
    const eId = req.entrepriseId;
    if (!eId) return res.status(400).json({ error: 'entrepriseId requis' });
    const { debut, fin } = getMonthDates();
    
    // Ventes du mois
    const ventesData = await db.query.factures.findMany({
      where: and(
        eq(factures.entrepriseId, eId),
        gte(factures.createdAt, debut),
        lte(factures.createdAt, fin)
      )
    });
    const ventesMois = ventesData.reduce((sum, f) => sum + parseFloat(f.totalTTC || 0), 0);

    // Dépenses du mois
    const depensesData = await db.query.facturesAchat.findMany({
      where: and(
        eq(facturesAchat.entrepriseId, eId),
        gte(facturesAchat.createdAt, debut),
        lte(facturesAchat.createdAt, fin)
      )
    });
    const depensesMois = depensesData.reduce((sum, f) => sum + parseFloat(f.totalTTC || 0), 0);
    
    const marge = ventesMois - depensesMois;
    const margePercent = ventesMois > 0 ? ((marge / ventesMois) * 100).toFixed(2) : 0;
    
    res.json([
      { type: 'Chiffre d\'affaires', description: `Total des ventes du mois (${ventesData.length} factures)`, montant: ventesMois, impact: '+' },
      { type: 'Coût des ventes', description: `Achats fournisseurs (${depensesData.length} factures)`, montant: -depensesMois, impact: '-' },
      { type: 'Marge brute', description: `Résultat: ${margePercent}% de marge`, montant: marge, impact: '=' }
    ]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Drill-down: Ventes d'un mois spécifique (dans la période sélectionnée)
router.get('/detail/ventes-mois', async (req, res) => {
  try {
    const { mois, dateDebut, dateFin } = req.query;
    const eId = req.entrepriseId;
    if (!eId) return res.status(400).json({ error: 'entrepriseId requis' });
    
    // Parser le mois (format: "janv. 24")
    const moisMap = {
      'janv.': 0, 'févr.': 1, 'mars': 2, 'avr.': 3, 'mai': 4, 'juin': 5,
      'juil.': 6, 'août': 7, 'sept.': 8, 'oct.': 9, 'nov.': 10, 'déc.': 11
    };
    
    let targetYear, targetMonth;
    if (mois) {
      const parts = mois.split(' ');
      const moisNom = parts[0];
      const annee = parts[1] ? parseInt('20' + parts[1]) : new Date().getFullYear();
      targetMonth = moisMap[moisNom] !== undefined ? moisMap[moisNom] : new Date().getMonth();
      targetYear = annee;
    } else {
      const now = new Date();
      targetMonth = now.getMonth();
      targetYear = now.getFullYear();
    }
    
    // Bornes du mois cliqué
    let debut = new Date(targetYear, targetMonth, 1);
    let fin = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);
    
    // Contraindre aux bornes de la période sélectionnée si fournies
    if (dateDebut) {
      const periodStart = new Date(dateDebut);
      if (periodStart > debut) debut = periodStart;
    }
    if (dateFin) {
      const periodEnd = new Date(dateFin);
      periodEnd.setHours(23, 59, 59);
      if (periodEnd < fin) fin = periodEnd;
    }
    
    const ventesData = await db.query.factures.findMany({
      where: and(
        eq(factures.entrepriseId, eId),
        gte(factures.createdAt, debut),
        lte(factures.createdAt, fin)
      ),
      orderBy: [desc(factures.createdAt)]
    });
    
    // Récupérer les noms des clients
    const { clients } = await import('../schema.js');
    const clientsData = await db.query.clients.findMany({
      where: eq(clients.entrepriseId, eId)
    });
    const clientMap = {};
    clientsData.forEach(c => clientMap[c.id] = c.nom);
    
    const result = ventesData.map(f => ({
      id: f.id,
      numero: f.numero,
      dateFacture: f.dateFacture || f.createdAt,
      clientNom: clientMap[f.clientId] || 'Client inconnu',
      montantTTC: parseFloat(f.totalTTC || 0),
      statut: f.statut
    }));
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Drill-down: Dépenses par catégorie
router.get('/detail/depenses-categorie', async (req, res) => {
  try {
    const { categorie, dateDebut, dateFin } = req.query;
    const eId = req.entrepriseId;
    if (!eId) return res.status(400).json({ error: 'entrepriseId requis' });
    
    const { debut: defaultDebut, fin: defaultFin } = await getFiscalYearDatesForEntreprise(eId);
    const debut = dateDebut ? new Date(dateDebut) : defaultDebut;
    const fin = dateFin ? new Date(dateFin) : defaultFin;
    
    let whereCondition = and(
      eq(facturesAchat.entrepriseId, eId),
      gte(facturesAchat.createdAt, debut),
      lte(facturesAchat.createdAt, fin)
    );
    
    // Si une catégorie est spécifiée, filtrer par catégorie
    if (categorie && categorie !== 'Autre') {
      whereCondition = and(
        whereCondition,
        eq(facturesAchat.categorie, categorie)
      );
    } else if (categorie === 'Autre') {
      // Catégorie null ou vide
    }
    
    const depensesData = await db.query.facturesAchat.findMany({
      where: whereCondition,
      orderBy: [desc(facturesAchat.createdAt)]
    });
    
    // Récupérer les noms des fournisseurs
    const { fournisseurs } = await import('../schema.js');
    const fournisseursData = await db.query.fournisseurs.findMany({
      where: eq(fournisseurs.entrepriseId, eId)
    });
    const fournisseurMap = {};
    fournisseursData.forEach(f => fournisseurMap[f.id] = f.nom);
    
    const result = depensesData.map(f => ({
      id: f.id,
      date: f.dateFacture || f.createdAt,
      description: f.description || `Facture ${f.numero || f.id}`,
      categorie: f.categorie || 'Autre',
      fournisseur: fournisseurMap[f.fournisseurId] || 'Fournisseur inconnu',
      montant: parseFloat(f.totalTTC || 0)
    }));
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
