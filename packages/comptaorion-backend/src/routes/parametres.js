import express from 'express';
import { db } from '../db.js';
import { entreprises } from '../schema.js';
import { eq } from 'drizzle-orm';
import { logAudit, extractAuditInfo } from '../utils/auditLogger.js';

const router = express.Router();

// Liste des devises supportées avec symboles
const DEVISES = [
  // Afrique
  { code: 'XOF', nom: 'Franc CFA (BCEAO)', symbole: 'FCFA', pays: ['Bénin', 'Burkina Faso', 'Côte d\'Ivoire', 'Mali', 'Niger', 'Sénégal', 'Togo', 'Guinée-Bissau'] },
  { code: 'XAF', nom: 'Franc CFA (BEAC)', symbole: 'FCFA', pays: ['Cameroun', 'Centrafrique', 'Congo', 'Gabon', 'Guinée équatoriale', 'Tchad'] },
  { code: 'MAD', nom: 'Dirham marocain', symbole: 'DH', pays: ['Maroc'] },
  { code: 'TND', nom: 'Dinar tunisien', symbole: 'DT', pays: ['Tunisie'] },
  { code: 'DZD', nom: 'Dinar algérien', symbole: 'DA', pays: ['Algérie'] },
  { code: 'EGP', nom: 'Livre égyptienne', symbole: 'E£', pays: ['Égypte'] },
  { code: 'ZAR', nom: 'Rand sud-africain', symbole: 'R', pays: ['Afrique du Sud'] },
  { code: 'NGN', nom: 'Naira nigérian', symbole: '₦', pays: ['Nigeria'] },
  { code: 'GHS', nom: 'Cedi ghanéen', symbole: 'GH₵', pays: ['Ghana'] },
  { code: 'KES', nom: 'Shilling kenyan', symbole: 'KSh', pays: ['Kenya'] },
  
  // Europe
  { code: 'EUR', nom: 'Euro', symbole: '€', pays: ['France', 'Allemagne', 'Belgique', 'Espagne', 'Italie', 'etc.'] },
  { code: 'GBP', nom: 'Livre sterling', symbole: '£', pays: ['Royaume-Uni'] },
  { code: 'CHF', nom: 'Franc suisse', symbole: 'CHF', pays: ['Suisse'] },
  
  // Amérique
  { code: 'USD', nom: 'Dollar américain', symbole: '$', pays: ['États-Unis'] },
  { code: 'CAD', nom: 'Dollar canadien', symbole: 'CA$', pays: ['Canada'] },
  { code: 'BRL', nom: 'Real brésilien', symbole: 'R$', pays: ['Brésil'] },
  
  // Asie
  { code: 'CNY', nom: 'Yuan chinois', symbole: '¥', pays: ['Chine'] },
  { code: 'JPY', nom: 'Yen japonais', symbole: '¥', pays: ['Japon'] },
  { code: 'INR', nom: 'Roupie indienne', symbole: '₹', pays: ['Inde'] },
  
  // Autres
  { code: 'AUD', nom: 'Dollar australien', symbole: 'A$', pays: ['Australie'] },
  { code: 'NZD', nom: 'Dollar néo-zélandais', symbole: 'NZ$', pays: ['Nouvelle-Zélande'] },
];

// Systèmes comptables supportés
const SYSTEMES_COMPTABLES = [
  {
    code: 'SYSCOHADA',
    nom: 'SYSCOHADA',
    description: 'Système Comptable OHADA - Zone UEMOA/CEMAC',
    pays: ['Afrique de l\'Ouest et Centrale'],
    caracteristiques: [
      'Plan comptable à 9 classes',
      'Nomenclature standardisée OHADA',
      'États financiers SYSCOHADA',
      'Adapté aux PME africaines'
    ]
  },
  {
    code: 'IFRS',
    nom: 'IFRS',
    description: 'Normes Internationales d\'Information Financière',
    pays: ['International'],
    caracteristiques: [
      'Normes internationales',
      'Transparence financière maximale',
      'Adapté aux grandes entreprises',
      'Reconnu mondialement'
    ]
  },
  {
    code: 'PCG',
    nom: 'Plan Comptable Général',
    description: 'Plan Comptable Général (France)',
    pays: ['France'],
    caracteristiques: [
      'Plan comptable français',
      'Adapté au droit français',
      'Utilisé en France et DOM-TOM'
    ]
  }
];

// Taux de TVA par pays/région
const TAUX_TVA = {
  // Afrique (Zone UEMOA/CEMAC - SYSCOHADA)
  'Bénin': 18,
  'Burkina Faso': 18,
  'Côte d\'Ivoire': 18,
  'Mali': 18,
  'Niger': 19,
  'Sénégal': 18,
  'Togo': 18,
  'Cameroun': 19.25,
  'Gabon': 18,
  
  // Afrique du Nord
  'Maroc': 20,
  'Tunisie': 19,
  'Algérie': 19,
  'Égypte': 14,
  
  // Afrique subsaharienne
  'Afrique du Sud': 15,
  'Nigeria': 7.5,
  'Ghana': 12.5,
  'Kenya': 16,
  
  // Europe
  'France': 20,
  'Belgique': 21,
  'Allemagne': 19,
  'Espagne': 21,
  'Italie': 22,
  'Royaume-Uni': 20,
  'Suisse': 8.1,
  
  // Amérique
  'États-Unis': 0, // Varie par État
  'Canada': 5, // TPS fédérale (+ taxes provinciales)
  'Brésil': 17,
  
  // Par défaut
  'default': 18
};

// GET /api/parametres/entreprise - Récupérer les paramètres de l'entreprise courante
router.get('/entreprise', async (req, res) => {
  try {
    const [entreprise] = await db
      .select()
      .from(entreprises)
      .where(eq(entreprises.id, req.entrepriseId))
      .limit(1);

    if (!entreprise) {
      return res.status(404).json({ 
        success: false, 
        message: 'Entreprise non trouvée' 
      });
    }

    return res.json({ 
      success: true, 
      data: entreprise 
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des paramètres:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Erreur lors de la récupération des paramètres',
      error: error.message 
    });
  }
});

// PUT /api/parametres/entreprise - Mettre à jour les paramètres de l'entreprise
router.put('/entreprise', async (req, res) => {
  try {
    const {
      nom,
      raisonSociale,
      numeroSiret,
      adresse,
      ville,
      pays,
      telephone,
      email,
      devise,
      symboleDevise,
      tauxTva,
      systemeComptable,
      debutAnneeFiscale,
      finAnneeFiscale,
      numeroTva,
      registreCommerce,
      codeNaf,
      formeJuridique,
      logoUrl,
      factureFooterText,
      factureMentionsLegales,
      factureCouleurPrincipale,
      factureAfficherLogo
    } = req.body;

    // Validation des données
    if (systemeComptable && !['SYSCOHADA', 'IFRS', 'PCG'].includes(systemeComptable)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Système comptable invalide. Valeurs acceptées : SYSCOHADA, IFRS, PCG' 
      });
    }

    if (tauxTva !== undefined) {
      const taux = parseFloat(tauxTva);
      if (isNaN(taux) || taux < 0 || taux > 100) {
        return res.status(400).json({ 
          success: false, 
          message: 'Le taux de TVA doit être entre 0 et 100' 
        });
      }
    }

    // Validation de l'année fiscale
    if (debutAnneeFiscale && finAnneeFiscale) {
      const debut = new Date(debutAnneeFiscale);
      const fin = new Date(finAnneeFiscale);
      if (debut >= fin) {
        return res.status(400).json({ 
          success: false, 
          message: 'La date de début de l\'année fiscale doit être avant la date de fin' 
        });
      }
    }

    if (email && !email.includes('@')) {
      return res.status(400).json({ 
        success: false, 
        message: 'Email invalide' 
      });
    }

    // Vérifier que l'entreprise existe
    const [existingEntreprise] = await db
      .select()
      .from(entreprises)
      .where(eq(entreprises.id, req.entrepriseId))
      .limit(1);

    if (!existingEntreprise) {
      return res.status(404).json({ 
        success: false, 
        message: 'Entreprise non trouvée' 
      });
    }

    // Préparer les données à mettre à jour
    const updateData = {};
    
    if (nom !== undefined) updateData.nom = nom;
    if (raisonSociale !== undefined) updateData.raisonSociale = raisonSociale;
    if (numeroSiret !== undefined) updateData.numeroSiret = numeroSiret;
    if (adresse !== undefined) updateData.adresse = adresse;
    if (ville !== undefined) updateData.ville = ville;
    if (pays !== undefined) updateData.pays = pays;
    if (telephone !== undefined) updateData.telephone = telephone;
    if (email !== undefined) updateData.email = email;
    if (devise !== undefined) updateData.devise = devise;
    if (symboleDevise !== undefined) updateData.symboleDevise = symboleDevise;
    if (tauxTva !== undefined) updateData.tauxTva = tauxTva.toString();
    if (systemeComptable !== undefined) updateData.systemeComptable = systemeComptable;
    if (debutAnneeFiscale !== undefined) updateData.debutAnneeFiscale = debutAnneeFiscale;
    if (finAnneeFiscale !== undefined) updateData.finAnneeFiscale = finAnneeFiscale;
    if (numeroTva !== undefined) updateData.numeroTva = numeroTva;
    if (registreCommerce !== undefined) updateData.registreCommerce = registreCommerce;
    if (codeNaf !== undefined) updateData.codeNaf = codeNaf;
    if (formeJuridique !== undefined) updateData.formeJuridique = formeJuridique;
    if (logoUrl !== undefined) updateData.logoUrl = logoUrl;
    if (factureFooterText !== undefined) updateData.factureFooterText = factureFooterText;
    if (factureMentionsLegales !== undefined) updateData.factureMentionsLegales = factureMentionsLegales;
    if (factureCouleurPrincipale !== undefined) updateData.factureCouleurPrincipale = factureCouleurPrincipale;
    if (factureAfficherLogo !== undefined) updateData.factureAfficherLogo = factureAfficherLogo;

    updateData.updatedAt = new Date();

    // Mettre à jour
    const [updated] = await db
      .update(entreprises)
      .set(updateData)
      .where(eq(entreprises.id, req.entrepriseId))
      .returning();

    // Audit log
    const auditInfo = extractAuditInfo(req);
    await logAudit({
      ...auditInfo,
      action: 'UPDATE',
      table: 'entreprises',
      recordId: req.entrepriseId,
      ancienneValeur: existingEntreprise,
      nouvelleValeur: updated,
      description: `Paramètres entreprise modifiés: ${updated.nom || updated.raisonSociale}`
    });

    return res.json({ 
      success: true, 
      message: 'Paramètres mis à jour avec succès',
      data: updated 
    });
  } catch (error) {
    console.error('Erreur lors de la mise à jour des paramètres:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Erreur lors de la mise à jour des paramètres',
      error: error.message 
    });
  }
});

// GET /api/parametres/devises - Liste des devises supportées
router.get('/devises', (req, res) => {
  return res.json({ 
    success: true, 
    data: DEVISES 
  });
});

// GET /api/parametres/systemes-comptables - Liste des systèmes comptables
router.get('/systemes-comptables', (req, res) => {
  return res.json({ 
    success: true, 
    data: SYSTEMES_COMPTABLES 
  });
});

// GET /api/parametres/taux-tva - Taux de TVA par pays
router.get('/taux-tva', (req, res) => {
  const { pays } = req.query;
  
  if (pays) {
    const taux = TAUX_TVA[pays] || TAUX_TVA.default;
    return res.json({ 
      success: true, 
      data: { pays, taux } 
    });
  }
  
  return res.json({ 
    success: true, 
    data: TAUX_TVA 
  });
});

// GET /api/parametres/pays - Liste des pays supportés
router.get('/pays', (req, res) => {
  const pays = [
    // Afrique de l'Ouest (UEMOA)
    { nom: 'Bénin', code: 'BJ', region: 'Afrique de l\'Ouest', devise: 'XOF', systeme: 'SYSCOHADA' },
    { nom: 'Burkina Faso', code: 'BF', region: 'Afrique de l\'Ouest', devise: 'XOF', systeme: 'SYSCOHADA' },
    { nom: 'Côte d\'Ivoire', code: 'CI', region: 'Afrique de l\'Ouest', devise: 'XOF', systeme: 'SYSCOHADA' },
    { nom: 'Guinée-Bissau', code: 'GW', region: 'Afrique de l\'Ouest', devise: 'XOF', systeme: 'SYSCOHADA' },
    { nom: 'Mali', code: 'ML', region: 'Afrique de l\'Ouest', devise: 'XOF', systeme: 'SYSCOHADA' },
    { nom: 'Niger', code: 'NE', region: 'Afrique de l\'Ouest', devise: 'XOF', systeme: 'SYSCOHADA' },
    { nom: 'Sénégal', code: 'SN', region: 'Afrique de l\'Ouest', devise: 'XOF', systeme: 'SYSCOHADA' },
    { nom: 'Togo', code: 'TG', region: 'Afrique de l\'Ouest', devise: 'XOF', systeme: 'SYSCOHADA' },
    
    // Afrique Centrale (CEMAC)
    { nom: 'Cameroun', code: 'CM', region: 'Afrique Centrale', devise: 'XAF', systeme: 'SYSCOHADA' },
    { nom: 'Centrafrique', code: 'CF', region: 'Afrique Centrale', devise: 'XAF', systeme: 'SYSCOHADA' },
    { nom: 'Congo', code: 'CG', region: 'Afrique Centrale', devise: 'XAF', systeme: 'SYSCOHADA' },
    { nom: 'Gabon', code: 'GA', region: 'Afrique Centrale', devise: 'XAF', systeme: 'SYSCOHADA' },
    { nom: 'Guinée équatoriale', code: 'GQ', region: 'Afrique Centrale', devise: 'XAF', systeme: 'SYSCOHADA' },
    { nom: 'Tchad', code: 'TD', region: 'Afrique Centrale', devise: 'XAF', systeme: 'SYSCOHADA' },
    
    // Afrique du Nord
    { nom: 'Maroc', code: 'MA', region: 'Afrique du Nord', devise: 'MAD', systeme: 'PCG' },
    { nom: 'Tunisie', code: 'TN', region: 'Afrique du Nord', devise: 'TND', systeme: 'PCG' },
    { nom: 'Algérie', code: 'DZ', region: 'Afrique du Nord', devise: 'DZD', systeme: 'PCG' },
    { nom: 'Égypte', code: 'EG', region: 'Afrique du Nord', devise: 'EGP', systeme: 'IFRS' },
    
    // Afrique subsaharienne
    { nom: 'Afrique du Sud', code: 'ZA', region: 'Afrique australe', devise: 'ZAR', systeme: 'IFRS' },
    { nom: 'Nigeria', code: 'NG', region: 'Afrique de l\'Ouest', devise: 'NGN', systeme: 'IFRS' },
    { nom: 'Ghana', code: 'GH', region: 'Afrique de l\'Ouest', devise: 'GHS', systeme: 'IFRS' },
    { nom: 'Kenya', code: 'KE', region: 'Afrique de l\'Est', devise: 'KES', systeme: 'IFRS' },
    
    // Europe
    { nom: 'France', code: 'FR', region: 'Europe', devise: 'EUR', systeme: 'PCG' },
    { nom: 'Belgique', code: 'BE', region: 'Europe', devise: 'EUR', systeme: 'PCG' },
    { nom: 'Suisse', code: 'CH', region: 'Europe', devise: 'CHF', systeme: 'IFRS' },
    { nom: 'Royaume-Uni', code: 'GB', region: 'Europe', devise: 'GBP', systeme: 'IFRS' },
    
    // Amérique
    { nom: 'États-Unis', code: 'US', region: 'Amérique du Nord', devise: 'USD', systeme: 'IFRS' },
    { nom: 'Canada', code: 'CA', region: 'Amérique du Nord', devise: 'CAD', systeme: 'IFRS' },
    { nom: 'Brésil', code: 'BR', region: 'Amérique du Sud', devise: 'BRL', systeme: 'IFRS' },
  ];

  return res.json({ 
    success: true, 
    data: pays 
  });
});

// ==========================================
// AUDIT LOG
// ==========================================

router.get('/audit-logs', async (req, res) => {
  try {
    const { entrepriseId, limit = 100, offset = 0 } = req.query;
    const { auditLogs } = await import('../schema.js');
    
    const logs = await db.query.auditLogs.findMany({
      where: eq(auditLogs.entrepriseId, parseInt(entrepriseId)),
      limit: parseInt(limit),
      offset: parseInt(offset),
      orderBy: (logs) => [desc(logs.createdAt)]
    });
    
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/audit-logs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { auditLogs } = await import('../schema.js');
    
    const log = await db.query.auditLogs.findFirst({
      where: eq(auditLogs.id, parseInt(id))
    });
    
    res.json(log);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/audit-stats', async (req, res) => {
  try {
    const { entrepriseId, startDate, endDate } = req.query;
    const { auditLogs } = await import('../schema.js');
    
    // Statistiques par action
    const stats = await db.query.auditLogs.findMany({
      where: and(
        eq(auditLogs.entrepriseId, parseInt(entrepriseId)),
        startDate ? gte(auditLogs.createdAt, new Date(startDate)) : undefined,
        endDate ? lte(auditLogs.createdAt, new Date(endDate)) : undefined
      )
    });
    
    const summary = {
      total: stats.length,
      byAction: {
        CREATE: stats.filter(s => s.action === 'CREATE').length,
        UPDATE: stats.filter(s => s.action === 'UPDATE').length,
        DELETE: stats.filter(s => s.action === 'DELETE').length,
        READ: stats.filter(s => s.action === 'READ').length
      },
      byTable: {}
    };
    
    stats.forEach(log => {
      summary.byTable[log.table] = (summary.byTable[log.table] || 0) + 1;
    });
    
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
