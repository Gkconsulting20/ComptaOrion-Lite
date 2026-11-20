import express from 'express';
import { db } from '../db.js';
import { saasCommerciaux, saasClients, saasVentes, plansAbonnement, abonnements, facturesAbonnement, entreprises } from '../schema.js';
import { eq, and, sql, desc } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { creerAbonnementPayant } from '../saas-offre.js';

const router = express.Router();

// ===========================================
// DASHBOARD SAAS ADMIN
// ===========================================

router.get('/dashboard', async (req, res) => {
  try {
    const stats = await db.execute(sql`
      WITH 
        client_counts AS (
          SELECT 
            COUNT(*) as total_clients,
            COUNT(CASE WHEN statut = 'actif' THEN 1 END) as clients_actifs,
            COUNT(CASE WHEN statut = 'trial' THEN 1 END) as clients_trial
          FROM saas_clients
        ),
        commercial_counts AS (
          SELECT COUNT(*) as total_commerciaux
          FROM saas_commerciaux
          WHERE actif = true
        ),
        abonnement_stats AS (
          SELECT 
            COUNT(*) as total_abonnements,
            -- MRR : un abonnement en période gratuite (avant sa date de
            -- début de facturation) ne contribue pas ; un abonnement sans
            -- mois payé (durée ≤ mois gratuits, donc expiration ≤ début
            -- de facturation) ne contribue jamais. Les lignes déjà en
            -- base, sans date_debut_facturation, sont comptées comme
            -- avant (facturation dès le début).
            COALESCE(SUM(CASE WHEN statut = 'actif'
              AND COALESCE(date_debut_facturation, date_debut) <= CURRENT_DATE
              AND date_expiration > COALESCE(date_debut_facturation, date_debut)
              THEN montant_mensuel ELSE 0 END), 0) as mrr_total
          FROM abonnements
        ),
        vente_stats AS (
          SELECT 
            COALESCE(SUM(montant_vente), 0) as ca_total,
            COALESCE(SUM(commission), 0) as commissions_total
          FROM saas_ventes
          WHERE statut = 'confirmée'
        )
      SELECT 
        cc.total_clients,
        cc.clients_actifs,
        cc.clients_trial,
        com.total_commerciaux,
        ab.total_abonnements,
        ab.mrr_total,
        v.ca_total,
        v.commissions_total
      FROM client_counts cc
      CROSS JOIN commercial_counts com
      CROSS JOIN abonnement_stats ab
      CROSS JOIN vente_stats v
    `);

    const derniersClients = await db.select({
      id: saasClients.id,
      entrepriseNom: entreprises.nom,
      statut: saasClients.statut,
      dateInscription: saasClients.dateInscription,
      commercial: sql`${saasCommerciaux.nom} || ' ' || ${saasCommerciaux.prenom}`,
    })
    .from(saasClients)
    .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
    .leftJoin(saasCommerciaux, eq(saasClients.commercialId, saasCommerciaux.id))
    .orderBy(desc(saasClients.dateInscription))
    .limit(10);

    res.json({
      stats: stats[0] || {},
      derniersClients
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// GESTION DES COMMERCIAUX
// ===========================================

router.get('/commerciaux', async (req, res) => {
  try {
    const commerciaux = await db.select().from(saasCommerciaux).orderBy(desc(saasCommerciaux.createdAt));
    res.json(commerciaux);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/commerciaux', async (req, res) => {
  try {
    const { nom, prenom, email, telephone, region, objectifMensuel, password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Le mot de passe est obligatoire pour créer un commercial' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const [commercial] = await db.insert(saasCommerciaux).values({
      nom,
      prenom,
      email: email ? email.toLowerCase() : null,
      telephone,
      passwordHash,
      region,
      commission: 10,
      objectifMensuel,
      actif: true
    }).returning();

    res.json(commercial);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/commerciaux/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { password, ...updates } = req.body;
    updates.commission = 10;

    if (password) {
      updates.passwordHash = await bcrypt.hash(password, 10);
    }

    if (updates.email) {
      updates.email = updates.email.toLowerCase();
    }

    const [commercial] = await db.update(saasCommerciaux)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(saasCommerciaux.id, parseInt(id)))
      .returning();

    res.json(commercial);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/commerciaux/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(saasCommerciaux).where(eq(saasCommerciaux.id, parseInt(id)));
    res.json({ message: 'Commercial supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// GESTION DES CLIENTS SAAS
// ===========================================

router.get('/clients', async (req, res) => {
  try {
    const clients = await db.select({
      id: saasClients.id,
      entrepriseId: saasClients.entrepriseId,
      entrepriseNom: entreprises.nom,
      entrepriseEmail: entreprises.email,
      statut: saasClients.statut,
      dateInscription: saasClients.dateInscription,
      dateDerniereConnexion: saasClients.dateDerniereConnexion,
      source: saasClients.source,
      commercial: sql`${saasCommerciaux.nom} || ' ' || ${saasCommerciaux.prenom}`,
      commercialId: saasClients.commercialId,
      notes: saasClients.notes,
      abonnement: {
        planNom: plansAbonnement.nom,
        montant: abonnements.montantMensuel,
        statut: abonnements.statut
      }
    })
    .from(saasClients)
    .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
    .leftJoin(saasCommerciaux, eq(saasClients.commercialId, saasCommerciaux.id))
    .leftJoin(abonnements, eq(saasClients.entrepriseId, abonnements.entrepriseId))
    .leftJoin(plansAbonnement, eq(abonnements.planId, plansAbonnement.id))
    .orderBy(desc(saasClients.dateInscription));

    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/clients', async (req, res) => {
  try {
    const { entrepriseId, commercialId, statut, source, notes } = req.body;

    const [client] = await db.insert(saasClients).values({
      entrepriseId: parseInt(entrepriseId),
      commercialId: commercialId ? parseInt(commercialId) : null,
      statut: statut || 'trial',
      source,
      notes
    }).returning();

    res.json(client);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/clients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const [client] = await db.update(saasClients)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(saasClients.id, parseInt(id)))
      .returning();

    res.json(client);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/clients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.delete(saasClients).where(eq(saasClients.id, parseInt(id)));
    res.json({ message: 'Client SaaS supprimé' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// GESTION DES PLANS TARIFAIRES
// ===========================================

router.get('/plans', async (req, res) => {
  try {
    const plans = await db.select().from(plansAbonnement).orderBy(plansAbonnement.prix);
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/plans', async (req, res) => {
  try {
    const data = req.body;

    const [plan] = await db.insert(plansAbonnement).values({
      ...data,
      actif: true
    }).returning();

    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/plans/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const [plan] = await db.update(plansAbonnement)
      .set(updates)
      .where(eq(plansAbonnement.id, parseInt(id)))
      .returning();

    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// GESTION DES ABONNEMENTS
// ===========================================

router.get('/abonnements', async (req, res) => {
  try {
    const abonnementsList = await db.select({
      id: abonnements.id,
      entreprise: entreprises.nom,
      plan: plansAbonnement.nom,
      statut: abonnements.statut,
      dateDebut: abonnements.dateDebut,
      dateExpiration: abonnements.dateExpiration,
      montantMensuel: abonnements.montantMensuel
    })
    .from(abonnements)
    .leftJoin(entreprises, eq(abonnements.entrepriseId, entreprises.id))
    .leftJoin(plansAbonnement, eq(abonnements.planId, plansAbonnement.id))
    .orderBy(desc(abonnements.createdAt));

    res.json(abonnementsList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/abonnements', async (req, res) => {
  try {
    const { entrepriseId, planId, dateDebut, dureeEnMois } = req.body;

    // Offre « 2 mois gratuits » : voir saas-offre.js. La création met le
    // client en statut 'actif' et enregistre automatiquement la vente
    // (montant = prix × mois payés, commission due à partir du début
    // de facturation).
    const { abonnement, offre, commission } = await creerAbonnementPayant(db, {
      entrepriseId,
      planId,
      dateDebut,
      dureeEnMois,
    });

    res.json({
      success: true,
      message: offre.entierementGratuit
        ? 'Abonnement créé avec succès. Vente enregistrée automatiquement (entièrement gratuit — 2 mois offerts).'
        : `Abonnement créé avec succès. Vente enregistrée automatiquement (2 mois gratuits, facturation dès le ${offre.dateDebutFacturation}).`,
      abonnement,
      offre: {
        moisGratuits: offre.moisGratuits,
        moisPayants: offre.moisPayants,
        montantVente: offre.montantTotal,
        commission,
        dateDebutFacturation: offre.dateDebutFacturation,
      },
    });
  } catch (error) {
    console.error('Erreur création abonnement:', error);
    res.status(error.statut || 500).json({ error: error.message });
  }
});

router.put('/abonnements/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const [abonnement] = await db.update(abonnements)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(abonnements.id, parseInt(id)))
      .returning();

    res.json(abonnement);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// GESTION DES VENTES
// ===========================================

router.get('/ventes', async (req, res) => {
  try {
    const ventes = await db.select({
      id: saasVentes.id,
      commercial: sql`${saasCommerciaux.nom} || ' ' || ${saasCommerciaux.prenom}`,
      client: entreprises.nom,
      montantVente: saasVentes.montantVente,
      commission: saasVentes.commission,
      dateVente: saasVentes.dateVente,
      statut: saasVentes.statut,
      source: saasVentes.source
    })
    .from(saasVentes)
    .leftJoin(saasCommerciaux, eq(saasVentes.commercialId, saasCommerciaux.id))
    .leftJoin(saasClients, eq(saasVentes.clientId, saasClients.id))
    .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
    .orderBy(desc(saasVentes.dateVente));

    res.json(ventes);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/ventes', async (req, res) => {
  try {
    const { commercialId, clientId, abonnementId, montantVente, commission, notes } = req.body;

    const [vente] = await db.insert(saasVentes).values({
      commercialId: parseInt(commercialId),
      clientId: parseInt(clientId),
      abonnementId: abonnementId ? parseInt(abonnementId) : null,
      montantVente,
      commission: commercialId ? (Number(montantVente) * 0.10) : 0,
      statut: 'confirmée',
      notes
    }).returning();

    res.json(vente);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// RAPPORTS & STATISTIQUES
// ===========================================

router.get('/rapports/commerciaux', async (req, res) => {
  try {
    const rapports = await db.execute(sql`
      SELECT 
        c.id,
        c.nom || ' ' || c.prenom as nom_complet,
        c.region,
        c.commission,
        c.objectif_mensuel,
        COUNT(DISTINCT sc.id) as nb_clients,
        COUNT(DISTINCT CASE WHEN sc.statut = 'actif' THEN sc.id END) as nb_clients_actifs,
        COALESCE(SUM(sv.montant_vente), 0) as ca_total,
        COALESCE(SUM(sv.commission), 0) as commissions_totales
      FROM saas_commerciaux c
      LEFT JOIN saas_clients sc ON sc.commercial_id = c.id
      LEFT JOIN saas_ventes sv ON sv.commercial_id = c.id
      WHERE c.actif = true
      GROUP BY c.id, c.nom, c.prenom, c.region, c.commission, c.objectif_mensuel
      ORDER BY ca_total DESC
    `);

    res.json(rapports);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
