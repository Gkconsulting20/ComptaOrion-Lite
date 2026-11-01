import express from 'express';
import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db.js';
import {
  abonnements,
  entreprises,
  plansAbonnement,
  saasClients,
  saasCommerciaux,
  saasVentes,
  users,
} from '../schema.js';

const router = express.Router();
const OWNER_EMAIL = (process.env.SAAS_PLATFORM_OWNER_EMAIL || 'admin@orionexa.net').trim().toLowerCase();
const clientStatuses = new Set(['trial', 'suspendu', 'inactif']);
const planStatuses = new Set(['mensuel', 'annuel']);

export async function requirePlatformOwner(req, res, next) {
  if (!req.user?.id) return res.status(401).json({ error: 'Connexion requise.' });
  try {
    const [account] = await db
      .select({ email: users.email, role: users.role, actif: users.actif })
      .from(users)
      .where(eq(users.id, Number(req.user.id)))
      .limit(1);

    if (!account?.actif || account.role !== 'admin' || account.email?.trim().toLowerCase() !== OWNER_EMAIL) {
      return res.status(403).json({ error: 'Accès réservé à l’administrateur de la plateforme.' });
    }
    req.platformOwner = { email: OWNER_EMAIL };
    return next();
  } catch (error) {
    req.log?.error({ err: error }, 'Échec de vérification de l’accès plateforme');
    return res.status(500).json({ error: 'Impossible de vérifier les autorisations.' });
  }
}

function rowsOf(result) {
  return result?.rows || result || [];
}

router.get('/dashboard', async (req, res) => {
  try {
    const [clientStatsResult, subscriptionStatsResult, salesStatsResult, recentClients] = await Promise.all([
      db.execute(sql`
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE statut = 'actif')::int AS actifs,
          COUNT(*) FILTER (WHERE statut = 'trial')::int AS essais,
          COUNT(*) FILTER (WHERE statut = 'suspendu')::int AS suspendus
        FROM saas_clients
      `),
      db.execute(sql`
        SELECT COUNT(*) FILTER (WHERE statut = 'actif')::int AS abonnements_actifs,
          COALESCE(SUM(montant_mensuel) FILTER (WHERE statut = 'actif'), 0)::numeric AS revenu_mensuel
        FROM abonnements
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(montant_vente) FILTER (WHERE statut = 'confirmée'), 0)::numeric AS ventes,
          COALESCE(SUM(commission) FILTER (WHERE statut = 'confirmée'), 0)::numeric AS commissions
        FROM saas_ventes
      `),
      db.select({
        id: saasClients.id,
        entrepriseId: saasClients.entrepriseId,
        entrepriseNom: entreprises.nom,
        email: entreprises.email,
        statut: saasClients.statut,
        dateInscription: saasClients.dateInscription,
        source: saasClients.source,
      })
        .from(saasClients)
        .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
        .orderBy(desc(saasClients.dateInscription))
        .limit(8),
    ]);
    res.json({
      stats: {
        ...(rowsOf(clientStatsResult)[0] || {}),
        ...(rowsOf(subscriptionStatsResult)[0] || {}),
        ...(rowsOf(salesStatsResult)[0] || {}),
      },
      recentClients,
    });
  } catch (error) {
    req.log?.error({ err: error }, 'Échec du tableau de bord commercial');
    res.status(500).json({ error: 'Impossible de charger le tableau de bord commercial.' });
  }
});

router.get('/clients', async (_req, res) => {
  try {
    const clients = await db.select({
      id: saasClients.id,
      entrepriseId: saasClients.entrepriseId,
      entrepriseNom: entreprises.nom,
      email: entreprises.email,
      telephone: entreprises.telephone,
      pays: entreprises.pays,
      statut: saasClients.statut,
      dateInscription: saasClients.dateInscription,
      dateDerniereConnexion: saasClients.dateDerniereConnexion,
      source: saasClients.source,
      notes: saasClients.notes,
      commercialId: saasClients.commercialId,
      commercial: sql`COALESCE(${saasCommerciaux.prenom} || ' ' || ${saasCommerciaux.nom}, '')`,
    })
      .from(saasClients)
      .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
      .leftJoin(saasCommerciaux, eq(saasClients.commercialId, saasCommerciaux.id))
      .orderBy(desc(saasClients.dateInscription));
    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger les clients SaaS.' });
  }
});

router.patch('/clients/:id', async (req, res) => {
  const id = Number(req.params.id);
  const { statut, notes } = req.body || {};
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Identifiant client invalide.' });
  if (statut !== undefined && !clientStatuses.has(statut)) {
    return res.status(400).json({ error: 'Statut non autorisé. Une activation payante doit venir d’un paiement vérifié.' });
  }
  if (notes !== undefined && typeof notes !== 'string') return res.status(400).json({ error: 'Les notes doivent être du texte.' });
  const updates = { updatedAt: new Date() };
  if (statut !== undefined) updates.statut = statut;
  if (notes !== undefined) updates.notes = notes.slice(0, 2000);
  if (Object.keys(updates).length === 1) return res.status(400).json({ error: 'Aucune modification à enregistrer.' });

  try {
    const [client] = await db.update(saasClients)
      .set(updates)
      .where(eq(saasClients.id, id))
      .returning({ id: saasClients.id, statut: saasClients.statut, notes: saasClients.notes });
    if (!client) return res.status(404).json({ error: 'Client SaaS introuvable.' });
    res.json(client);
  } catch (error) {
    res.status(500).json({ error: 'Impossible de mettre à jour ce client.' });
  }
});

router.get('/plans', async (_req, res) => {
  try {
    const plans = await db.select().from(plansAbonnement).orderBy(plansAbonnement.prix);
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger les forfaits.' });
  }
});

router.post('/plans/proposals', async (_req, res) => {
  const proposals = [
    {
      nom: 'Solo — brouillon',
      prix: '2500',
      devise: 'XOF',
      periode: 'mensuel',
      limiteUtilisateurs: 1,
      limiteEntreprises: 1,
      stockageGb: 1,
      supportEmail: true,
      supportPrioritaire: false,
      featuresCRM: true,
      featuresRH: false,
      featuresComptabilite: true,
      descriptionFeatures: 'Brouillon à valider. Ventes, clients, dépenses, stock, rapports financiers. Plafond photo proposé : 10 par mois, non appliqué techniquement.',
      actif: false,
    },
    {
      nom: 'Commerce — brouillon',
      prix: '5000',
      devise: 'XOF',
      periode: 'mensuel',
      limiteUtilisateurs: 3,
      limiteEntreprises: 1,
      stockageGb: 3,
      supportEmail: true,
      supportPrioritaire: false,
      featuresCRM: true,
      featuresRH: false,
      featuresComptabilite: true,
      descriptionFeatures: 'Brouillon à valider. Toutes les fonctions Lite, 3 utilisateurs. Plafond photo proposé : 50 par mois, non appliqué techniquement.',
      actif: false,
    },
    {
      nom: 'Équipe — brouillon',
      prix: '10000',
      devise: 'XOF',
      periode: 'mensuel',
      limiteUtilisateurs: 10,
      limiteEntreprises: 1,
      stockageGb: 10,
      supportEmail: true,
      supportPrioritaire: true,
      featuresCRM: true,
      featuresRH: false,
      featuresComptabilite: true,
      descriptionFeatures: 'Brouillon à valider. Toutes les fonctions Lite, 10 utilisateurs. Plafond photo proposé : 150 par mois, non appliqué techniquement.',
      actif: false,
    },
  ];
  try {
    const current = await db.select({ nom: plansAbonnement.nom }).from(plansAbonnement);
    const existingNames = new Set(current.map((plan) => plan.nom.toLocaleLowerCase()));
    const missing = proposals.filter((plan) => !existingNames.has(plan.nom.toLocaleLowerCase()));
    if (missing.length) await db.insert(plansAbonnement).values(missing);
    const plans = await db.select().from(plansAbonnement).orderBy(plansAbonnement.prix);
    res.json({ created: missing.length, plans });
  } catch (error) {
    res.status(500).json({ error: 'Impossible de préparer les brouillons de forfaits.' });
  }
});

router.post('/plans', async (req, res) => {
  const body = req.body || {};
  const price = Number(body.prix);
  const seats = Number(body.limiteUtilisateurs);
  if (typeof body.nom !== 'string' || !body.nom.trim()) return res.status(400).json({ error: 'Le nom du forfait est obligatoire.' });
  if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Le prix doit être un montant valide.' });
  if (!Number.isSafeInteger(seats) || seats < 1 || seats > 10000) return res.status(400).json({ error: 'La limite d’utilisateurs est invalide.' });
  if (body.periode && !planStatuses.has(body.periode)) return res.status(400).json({ error: 'Période non prise en charge.' });
  try {
    const [plan] = await db.insert(plansAbonnement).values({
      nom: body.nom.trim().slice(0, 255),
      prix: String(price),
      devise: 'XOF',
      periode: body.periode || 'mensuel',
      limiteUtilisateurs: seats,
      limiteEntreprises: 1,
      stockageGb: 1,
      supportEmail: true,
      supportPrioritaire: Boolean(body.supportPrioritaire),
      featuresCRM: true,
      featuresRH: false,
      featuresComptabilite: true,
      descriptionFeatures: typeof body.descriptionFeatures === 'string' ? body.descriptionFeatures.slice(0, 2000) : '',
      actif: false,
    }).returning();
    res.status(201).json(plan);
  } catch (error) {
    res.status(500).json({ error: 'Impossible de créer ce forfait.' });
  }
});

router.patch('/plans/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Identifiant forfait invalide.' });
  const body = req.body || {};
  const updates = { updatedAt: new Date() };
  if (body.nom !== undefined) {
    if (typeof body.nom !== 'string' || !body.nom.trim()) return res.status(400).json({ error: 'Nom de forfait invalide.' });
    updates.nom = body.nom.trim().slice(0, 255);
  }
  if (body.prix !== undefined) {
    const price = Number(body.prix);
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ error: 'Prix invalide.' });
    updates.prix = String(price);
  }
  if (body.limiteUtilisateurs !== undefined) {
    const seats = Number(body.limiteUtilisateurs);
    if (!Number.isSafeInteger(seats) || seats < 1 || seats > 10000) return res.status(400).json({ error: 'Limite d’utilisateurs invalide.' });
    updates.limiteUtilisateurs = seats;
  }
  if (body.periode !== undefined) {
    if (!planStatuses.has(body.periode)) return res.status(400).json({ error: 'Période non prise en charge.' });
    updates.periode = body.periode;
  }
  if (body.descriptionFeatures !== undefined) {
    if (typeof body.descriptionFeatures !== 'string') return res.status(400).json({ error: 'Description invalide.' });
    updates.descriptionFeatures = body.descriptionFeatures.slice(0, 2000);
  }
  if (body.actif !== undefined) {
    if (typeof body.actif !== 'boolean') return res.status(400).json({ error: 'État du forfait invalide.' });
    updates.actif = body.actif;
  }
  if (Object.keys(updates).length === 1) return res.status(400).json({ error: 'Aucune modification à enregistrer.' });
  try {
    const [plan] = await db.update(plansAbonnement)
      .set(Object.fromEntries(Object.entries(updates).filter(([key]) => key !== 'updatedAt')))
      .where(eq(plansAbonnement.id, id))
      .returning();
    if (!plan) return res.status(404).json({ error: 'Forfait introuvable.' });
    res.json(plan);
  } catch (error) {
    res.status(500).json({ error: 'Impossible de mettre à jour ce forfait.' });
  }
});

router.get('/abonnements', async (_req, res) => {
  try {
    const list = await db.select({
      id: abonnements.id,
      entrepriseId: abonnements.entrepriseId,
      entreprise: entreprises.nom,
      planId: abonnements.planId,
      plan: plansAbonnement.nom,
      statut: abonnements.statut,
      dateDebut: abonnements.dateDebut,
      dateExpiration: abonnements.dateExpiration,
      montantMensuel: abonnements.montantMensuel,
      devise: plansAbonnement.devise,
    })
      .from(abonnements)
      .leftJoin(entreprises, eq(abonnements.entrepriseId, entreprises.id))
      .leftJoin(plansAbonnement, eq(abonnements.planId, plansAbonnement.id))
      .orderBy(desc(abonnements.createdAt));
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger les abonnements.' });
  }
});

router.get('/ventes', async (_req, res) => {
  try {
    const list = await db.select({
      id: saasVentes.id,
      commercial: sql`COALESCE(${saasCommerciaux.prenom} || ' ' || ${saasCommerciaux.nom}, 'Vente en ligne')`,
      client: entreprises.nom,
      montantVente: saasVentes.montantVente,
      commission: saasVentes.commission,
      dateVente: saasVentes.dateVente,
      statut: saasVentes.statut,
      source: saasVentes.source,
    })
      .from(saasVentes)
      .leftJoin(saasClients, eq(saasVentes.clientId, saasClients.id))
      .leftJoin(entreprises, eq(saasClients.entrepriseId, entreprises.id))
      .leftJoin(saasCommerciaux, eq(saasVentes.commercialId, saasCommerciaux.id))
      .orderBy(desc(saasVentes.dateVente))
      .limit(200);
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger les ventes SaaS.' });
  }
});

router.get('/commerciaux', async (_req, res) => {
  try {
    const list = await db.select({
      id: saasCommerciaux.id,
      nom: saasCommerciaux.nom,
      prenom: saasCommerciaux.prenom,
      email: saasCommerciaux.email,
      telephone: saasCommerciaux.telephone,
      region: saasCommerciaux.region,
      commission: saasCommerciaux.commission,
      objectifMensuel: saasCommerciaux.objectifMensuel,
      actif: saasCommerciaux.actif,
      createdAt: saasCommerciaux.createdAt,
    })
      .from(saasCommerciaux)
      .orderBy(desc(saasCommerciaux.createdAt));
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: 'Impossible de charger les commerciaux.' });
  }
});

router.get('/payment-readiness', (_req, res) => {
  res.json({
    provider: 'Whop',
    status: process.env.WHOP_COMPANY_ID ? 'company-configured' : 'blocked',
    configured: Boolean(process.env.WHOP_COMPANY_ID),
    currency: 'XOF',
    message: process.env.WHOP_COMPANY_ID
      ? 'Compte Whop détecté. La devise XOF et le checkout doivent encore être vérifiés.'
      : 'La connexion actuelle ne fournit pas l’autorisation de lecture entreprise requise; le checkout n’est pas activé.',
  });
});

export default router;
