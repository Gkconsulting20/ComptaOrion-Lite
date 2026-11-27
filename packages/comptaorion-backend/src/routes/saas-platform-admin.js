import express from 'express';
import { desc, eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
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
import { creerAbonnementPayant } from '../saas-offre.js';

const router = express.Router();
const OWNER_EMAIL = (process.env.SAAS_PLATFORM_OWNER_EMAIL || 'admin@orionexa.net').trim().toLowerCase();
const clientStatuses = new Set(['trial', 'suspendu', 'inactif']);
const planStatuses = new Set(['mensuel', 'annuel']);
const COMMISSION_RATE = '10';

function reportPeriod(req, res) {
  const today = new Date();
  const defaultTo = today.toISOString().slice(0, 10);
  const defaultFrom = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const from = String(req.query.from || defaultFrom);
  const to = String(req.query.to || defaultTo);
  const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (!validDate(from) || !validDate(to) || from > to) {
    res.status(400).json({ error: 'Période invalide. Utilisez des dates AAAA-MM-JJ avec un début antérieur à la fin.' });
    return null;
  }
  return { from, to };
}

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
          -- Revenu mensuel (MRR) : un abonnement en période gratuite
          -- (avant sa date de début de facturation) ne contribue pas ;
          -- un abonnement sans mois payé (durée ≤ mois gratuits, donc
          -- expiration ≤ début de facturation) ne contribue jamais.
          -- Les lignes déjà en base, sans date_debut_facturation, sont
          -- comptées comme avant (facturation dès le début).
          COALESCE(SUM(montant_mensuel) FILTER (WHERE statut = 'actif'
            AND COALESCE(date_debut_facturation, date_debut) <= CURRENT_DATE
            AND date_expiration > COALESCE(date_debut_facturation, date_debut)), 0)::numeric AS revenu_mensuel
        FROM abonnements
      `),
      db.execute(sql`
        SELECT COALESCE(SUM(montant_vente) FILTER (WHERE statut = 'confirmée'), 0)::numeric AS ventes,
          COALESCE(SUM(ROUND(montant_vente * 0.10, 2)) FILTER (WHERE statut = 'confirmée'), 0)::numeric AS commissions
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
      descriptionFeatures: [
        'FONCTIONNALITÉS INCLUSES',
        '• Pour les prestataires de services : professions libérales, consultants, artisans de service. Pas de négoce — ni stock, ni achats de marchandises',
        '• Tableau de bord et suivi quotidien de l’activité',
        '• Ventes de prestations multi-lignes, factures, clients et reçus',
        '• Catalogue de prestations et tarifs (sans stock)',
        '• Dépenses, approbations et remboursements des employés',
        '• Caisse et banque : encaissements et décaissements suivis (chèques exclus)',
        '• TVA au taux choisi par l’entreprise (0 %, 18 % ou personnalisé)',
        '• État des résultats, bilan financier, clôture d’exercice et impression des rapports',
        '• Analyse de ponctualité des paiements avec score indicatif, jamais décision automatique de crédit',
        '• Saisie différée hors connexion et synchronisation au retour du réseau',
        '• Saisie de facture ou reçu par photo, avec vérification avant enregistrement (Groq et connexion requis)',
        '• Assistance par courriel',
      ].join('\n'),
      actif: false,
    },
    {
      nom: 'Services — brouillon',
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
      descriptionFeatures: [
        'FONCTIONNALITÉS INCLUSES',
        '• Pour les prestataires de services, en petite équipe. Pas de négoce — ni stock, ni achats de marchandises',
        '• Toutes les fonctions du forfait Solo',
        '• Gestion de l’activité partagée entre plusieurs utilisateurs (jusqu’à 3)',
        '• Gestion partagée des ventes de prestations, clients et dépenses',
        '• TVA au taux choisi par l’entreprise (0 %, 18 % ou personnalisé)',
        '• État des résultats, bilan financier et clôture d’exercice',
        '• Travail hors connexion avec synchronisation au retour du réseau',
        '• Saisie de facture ou reçu par photo, avec vérification avant enregistrement (Groq et connexion requis)',
        '• Assistance par courriel',
      ].join('\n'),
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
      descriptionFeatures: [
        'FONCTIONNALITÉS INCLUSES',
        '• Pour les prestataires de services, en équipe. Pas de négoce — ni stock, ni achats de marchandises',
        '• Toutes les fonctions du forfait Services',
        '• Gestion d’équipe étendue (jusqu’à 10 utilisateurs) et assistance prioritaire',
        '• Gestion partagée des ventes de prestations, clients et dépenses',
        '• TVA au taux choisi par l’entreprise (0 %, 18 % ou personnalisé)',
        '• État des résultats, bilan financier et clôture d’exercice',
        '• Travail hors connexion avec synchronisation au retour du réseau',
        '• Saisie de facture ou reçu par photo, avec vérification avant enregistrement (Groq et connexion requis)',
        '• Assistance prioritaire par courriel',
      ].join('\n'),
      actif: false,
    },
  ];
  try {
    const current = await db.select().from(plansAbonnement);
    let created = 0;
    let updated = 0;
    for (const proposal of proposals) {
      const existing = current.find((plan) => plan.nom.toLocaleLowerCase() === proposal.nom.toLocaleLowerCase());
      if (existing && !existing.actif && existing.descriptionFeatures !== proposal.descriptionFeatures) {
        await db.update(plansAbonnement)
          .set({ descriptionFeatures: proposal.descriptionFeatures })
          .where(eq(plansAbonnement.id, existing.id));
        updated += 1;
      } else if (!existing) {
        await db.insert(plansAbonnement).values(proposal);
        created += 1;
      }
    }
    const plans = await db.select().from(plansAbonnement).orderBy(plansAbonnement.prix);
    res.json({ created, updated, plans });
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
      moisGratuits: abonnements.moisGratuits,
      dateDebutFacturation: abonnements.dateDebutFacturation,
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

// POST /abonnements — création d'un abonnement payant par
// l'administrateur de la plateforme (route montée sur /api/saas-admin,
// protégée par requirePlatformOwner). L'ancienne route équivalente
// (saas-admin.js) n'est montée nulle part : c'est celle-ci qui est
// joignable en production. Offre « 2 mois gratuits » : voir saas-offre.js.
router.post('/abonnements', async (req, res) => {
  try {
    const { entrepriseId, planId, dateDebut, dureeEnMois } = req.body || {};
    const { abonnement, offre, commission } = await creerAbonnementPayant(db, {
      entrepriseId,
      planId,
      dateDebut,
      dureeEnMois,
      source: 'commercial',
    });
    res.status(201).json({
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
    req.log?.error({ err: error }, 'Échec de création de l’abonnement');
    res.status(error.statut || 500).json({ error: error.message });
  }
});

router.get('/ventes', async (_req, res) => {
  try {
    const list = await db.select({
      id: saasVentes.id,
      commercial: sql`COALESCE(${saasCommerciaux.prenom} || ' ' || ${saasCommerciaux.nom}, 'Vente en ligne')`,
      client: entreprises.nom,
      montantVente: saasVentes.montantVente,
      commission: sql`CASE WHEN ${saasVentes.statut} = 'confirmée' THEN ROUND(${saasVentes.montantVente} * 0.10, 2) ELSE 0 END`,
      dateVente: saasVentes.dateVente,
      statut: saasVentes.statut,
      source: saasVentes.source,
      dateEcheanceCommission: saasVentes.dateEcheanceCommission,
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
      commission: sql`10`,
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

router.post('/commerciaux', async (req, res) => {
  const body = req.body || {};
  const nom = typeof body.nom === 'string' ? body.nom.trim() : '';
  const prenom = typeof body.prenom === 'string' ? body.prenom.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const telephone = typeof body.telephone === 'string' ? body.telephone.trim() : '';
  const region = typeof body.region === 'string' ? body.region.trim() : '';
  if (!nom || !prenom || !email || !password) {
    return res.status(400).json({ error: 'Le nom, le prénom, le courriel et le mot de passe sont obligatoires.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Adresse courriel invalide.' });
  }
  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir entre 8 et 200 caractères.' });
  }
  try {
    const [existing] = await db.select({ id: saasCommerciaux.id })
      .from(saasCommerciaux)
      .where(eq(saasCommerciaux.email, email))
      .limit(1);
    if (existing) return res.status(409).json({ error: 'Un compte commercial utilise déjà ce courriel.' });
    const passwordHash = await bcrypt.hash(password, 12);
    const [commercial] = await db.insert(saasCommerciaux).values({
      nom: nom.slice(0, 255),
      prenom: prenom.slice(0, 255),
      email,
      telephone: telephone.slice(0, 50) || null,
      region: region.slice(0, 100) || null,
      passwordHash,
      commission: COMMISSION_RATE,
      actif: true,
    }).returning({
      id: saasCommerciaux.id,
      nom: saasCommerciaux.nom,
      prenom: saasCommerciaux.prenom,
      email: saasCommerciaux.email,
      telephone: saasCommerciaux.telephone,
      region: saasCommerciaux.region,
      commission: saasCommerciaux.commission,
      actif: saasCommerciaux.actif,
      createdAt: saasCommerciaux.createdAt,
    });
    res.status(201).json(commercial);
  } catch (error) {
    req.log?.error({ err: error }, 'Échec de création du compte commercial');
    res.status(500).json({ error: 'Impossible de créer le compte commercial.' });
  }
});

router.patch('/commerciaux/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Identifiant commercial invalide.' });
  const body = req.body || {};
  const updates = { updatedAt: new Date() };
  const textFields = [
    ['nom', 255, true],
    ['prenom', 255, true],
    ['email', 255, true],
    ['telephone', 50, false],
    ['region', 100, false],
  ];

  for (const [field, maxLength, required] of textFields) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'string') return res.status(400).json({ error: `Valeur invalide pour ${field}.` });
    const value = body[field].trim();
    if (required && !value) return res.status(400).json({ error: `${field} est obligatoire.` });
    if (value.length > maxLength) return res.status(400).json({ error: `La valeur de ${field} est trop longue.` });
    if (field === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return res.status(400).json({ error: 'Adresse courriel invalide.' });
    }
    updates[field] = value ? (field === 'email' ? value.toLowerCase() : value) : null;
  }
  if (body.actif !== undefined) {
    if (typeof body.actif !== 'boolean') return res.status(400).json({ error: 'État du compte invalide.' });
    updates.actif = body.actif;
  }
  if (body.password !== undefined && body.password !== '') {
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 200) {
      return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir entre 8 et 200 caractères.' });
    }
  }
  if (Object.keys(updates).length === 1) return res.status(400).json({ error: 'Aucune modification à enregistrer.' });

  try {
    if (body.password) updates.passwordHash = await bcrypt.hash(body.password, 12);
    if (updates.email) {
      const [existing] = await db.select({ id: saasCommerciaux.id })
        .from(saasCommerciaux)
        .where(sql`LOWER(${saasCommerciaux.email}) = ${updates.email} AND ${saasCommerciaux.id} <> ${id}`)
        .limit(1);
      if (existing) return res.status(409).json({ error: 'Un autre compte commercial utilise déjà ce courriel.' });
    }
    const [commercial] = await db.update(saasCommerciaux)
      .set(updates)
      .where(eq(saasCommerciaux.id, id))
      .returning({
        id: saasCommerciaux.id,
        nom: saasCommerciaux.nom,
        prenom: saasCommerciaux.prenom,
        email: saasCommerciaux.email,
        telephone: saasCommerciaux.telephone,
        region: saasCommerciaux.region,
        commission: sql`10`,
        actif: saasCommerciaux.actif,
        createdAt: saasCommerciaux.createdAt,
      });
    if (!commercial) return res.status(404).json({ error: 'Commercial introuvable.' });
    res.json(commercial);
  } catch (error) {
    req.log?.error({ err: error }, 'Échec de mise à jour du compte commercial');
    res.status(500).json({ error: 'Impossible de mettre à jour ce compte commercial.' });
  }
});

router.get('/reports', async (req, res) => {
  const period = reportPeriod(req, res);
  if (!period) return;
  try {
    const report = await db.execute(sql`
      WITH clients AS (
        SELECT commercial_id, COUNT(*)::int AS clients
        FROM saas_clients
        WHERE commercial_id IS NOT NULL
          AND date_inscription >= ${period.from}::date
          AND date_inscription < (${period.to}::date + interval '1 day')
        GROUP BY commercial_id
      ),
      ventes AS (
        SELECT commercial_id, COUNT(*)::int AS ventes,
          COALESCE(SUM(montant_vente), 0)::numeric AS ca,
          COALESCE(SUM(ROUND(montant_vente * 0.10, 2)), 0)::numeric AS commissions
        FROM saas_ventes
        WHERE commercial_id IS NOT NULL
          AND statut = 'confirmée'
          AND date_vente >= ${period.from}::date
          AND date_vente < (${period.to}::date + interval '1 day')
        GROUP BY commercial_id
      )
      SELECT c.id, c.nom, c.prenom, c.region,
        COALESCE(cl.clients, 0)::int AS clients,
        COALESCE(v.ventes, 0)::int AS ventes,
        COALESCE(v.ca, 0)::numeric AS ca,
        COALESCE(v.commissions, 0)::numeric AS commissions
      FROM saas_commerciaux c
      LEFT JOIN clients cl ON cl.commercial_id = c.id
      LEFT JOIN ventes v ON v.commercial_id = c.id
      ORDER BY commissions DESC, ca DESC, c.nom ASC
    `);
    const commerciaux = rowsOf(report);
    const totals = commerciaux.reduce((sum, row) => ({
      clients: sum.clients + Number(row.clients || 0),
      ventes: sum.ventes + Number(row.ventes || 0),
      ca: sum.ca + Number(row.ca || 0),
      commissions: sum.commissions + Number(row.commissions || 0),
    }), { clients: 0, ventes: 0, ca: 0, commissions: 0 });
    res.json({ period, totals, commerciaux });
  } catch (error) {
    req.log?.error({ err: error }, 'Échec de génération du rapport commercial');
    res.status(500).json({ error: 'Impossible de générer le rapport commercial.' });
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
