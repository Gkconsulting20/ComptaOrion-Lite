import express from 'express';
import { db } from '../db.js';
import { users, entreprises } from '../schema.js';
import { and, eq, sql } from 'drizzle-orm';
import { hashPassword, requireRole } from '../auth.js';
import {
  limitesPourEntreprise,
  verifierLimiteUtilisateurs,
} from '../plan-limits.js';

const router = express.Router();

// ============================================================
// UTILISATEURS D'UNE ENTREPRISE — AJOUT PAR LE PROPRIÉTAIRE
// ============================================================
// Jusqu'ici, un utilisateur n'était créé qu'avec son entreprise
// (inscription, inscription publique, démo) : il n'existait aucun
// point d'ajout à une entreprise existante, donc la limite
// d'utilisateurs du forfait ne pouvait jamais se déclencher.
// Ce routeur comble ce manque, sans e-mail (aucune clé SendGrid
// aujourd'hui) : le propriétaire (rôle admin de l'entreprise) crée
// directement le compte du nouvel utilisateur — nom d'utilisateur,
// e-mail et mot de passe (≥ 12 caractères, même règle que
// l'inscription) — et lui transmet les identifiants par le canal de
// son choix. Le nouvel utilisateur se connecte ensuite normalement
// sur la page de connexion. Le rattachement à l'annuaire des
// employés se fait ensuite comme aujourd'hui, via le userId
// (Dépenses → Employés).
//
// Gardes :
// - Seul un admin de l'entreprise (requireRole('admin')) peut gérer
//   ses utilisateurs ; l'isolation par entreprise est portée par le
//   middleware global /api (req.entrepriseId).
// - La limite du forfait courant est vérifiée AVANT la création
//   (403 PLAN_LIMIT_REACHED, modèle Orion Santé) ; essai, démo et
//   propriétaire de la plateforme ne sont pas limités (plan-limits).
// - Aucune gestion d'utilisateurs dans une entreprise de
//   démonstration (bac à sable partagé, réinitialisé chaque jour).
// - Le rôle créé n'est jamais 'admin' (le créateur de l'entreprise
//   reste le seul admin) ; la désactivation d'un admin est refusée,
//   tout comme l'auto-désactivation.

const ROLES_AUTORISES = new Set(['manager', 'accountant', 'employee', 'viewer']);

const publicUser = (user) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  nom: user.nom,
  prenom: user.prenom,
  role: user.role,
  actif: user.actif,
  createdAt: user.createdAt,
});

function validerCreation(body) {
  const username = String(body?.username || '').trim();
  const email = String(body?.email || '').trim().toLowerCase();
  const password = body?.password;
  if (!username || username.length < 3 || username.length > 80) {
    return { erreur: 'Le nom d’utilisateur doit contenir entre 3 et 80 caractères.' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { erreur: 'Adresse email invalide.' };
  }
  if (typeof password !== 'string' || password.length < 12 || new TextEncoder().encode(password).length > 72) {
    return { erreur: 'Le mot de passe doit contenir au moins 12 caractères et au maximum 72 octets.' };
  }
  const role = body?.role === undefined || body?.role === null || body?.role === ''
    ? 'employee'
    : String(body.role).trim();
  if (!ROLES_AUTORISES.has(role)) {
    return { erreur: 'Rôle invalide (manager, accountant, employee ou viewer).' };
  }
  return {
    valeurs: {
      username,
      email,
      password,
      nom: typeof body?.nom === 'string' ? body.nom.trim().slice(0, 100) || null : null,
      prenom: typeof body?.prenom === 'string' ? body.prenom.trim().slice(0, 100) || null : null,
      role,
    },
  };
}

async function estDemo(entrepriseId) {
  const [entreprise] = await db.select()
    .from(entreprises)
    .where(eq(entreprises.id, Number(entrepriseId)))
    .limit(1);
  return entreprise?.isDemo === true;
}

router.use(requireRole('admin'));

router.get('/', async (req, res) => {
  try {
    const lignes = await db.select()
      .from(users)
      .where(eq(users.entrepriseId, Number(req.entrepriseId)));
    const limites = await limitesPourEntreprise(db, req.entrepriseId, req.user);
    res.json({
      utilisateurs: lignes.map(publicUser),
      limites: {
        illimite: limites.illimite,
        source: limites.source,
        planNom: limites.planNom,
        limiteUtilisateurs: limites.limiteUtilisateurs,
        utilisateursActuels: limites.utilisateursActuels,
      },
    });
  } catch (error) {
    console.error('Erreur GET /api/entreprise/utilisateurs :', error);
    res.status(500).json({ error: 'Impossible de charger les utilisateurs.' });
  }
});

router.post('/', async (req, res) => {
  try {
    const validation = validerCreation(req.body);
    if (validation.erreur) return res.status(400).json({ error: validation.erreur });
    const { username, email, password, nom, prenom, role } = validation.valeurs;

    if (await estDemo(req.entrepriseId)) {
      return res.status(403).json({ error: 'La démonstration ne permet pas d’ajouter des utilisateurs.' });
    }

    const [emailPris] = await db.select()
      .from(users)
      .where(sql`LOWER(${users.email}) = ${email}`)
      .limit(1);
    if (emailPris) return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    const [usernamePris] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (usernamePris) return res.status(400).json({ error: 'Ce nom d’utilisateur est déjà utilisé.' });

    // Limite du forfait courant (403 PLAN_LIMIT_REACHED au-delà).
    try {
      await verifierLimiteUtilisateurs(db, req.entrepriseId, req.user);
    } catch (error) {
      if (error.statut === 403) {
        return res.status(403).json({ error: error.message, code: error.code });
      }
      throw error;
    }

    const passwordHash = await hashPassword(password);
    const [cree] = await db.insert(users)
      .values({
        entrepriseId: Number(req.entrepriseId),
        username,
        email,
        passwordHash,
        nom,
        prenom,
        role,
        actif: true,
      })
      .returning();
    res.status(201).json({ message: 'Utilisateur créé.', user: publicUser(cree) });
  } catch (error) {
    console.error('Erreur POST /api/entreprise/utilisateurs :', error);
    res.status(500).json({ error: 'Erreur serveur lors de la création de l’utilisateur' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Identifiant utilisateur invalide.' });
    }
    if (req.body?.actif === undefined || typeof req.body.actif !== 'boolean') {
      return res.status(400).json({ error: 'Le champ actif (vrai ou faux) est requis.' });
    }
    if (id === Number(req.user?.id)) {
      return res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte.' });
    }
    if (await estDemo(req.entrepriseId)) {
      return res.status(403).json({ error: 'La démonstration ne permet pas de gérer des utilisateurs.' });
    }
    const [cible] = await db.select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.entrepriseId, Number(req.entrepriseId))))
      .limit(1);
    if (!cible) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    if (cible.role === 'admin') {
      return res.status(403).json({ error: 'Le compte administrateur de l’entreprise ne peut pas être désactivé ici.' });
    }
    const [misAJour] = await db.update(users)
      .set({ actif: req.body.actif, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning();
    res.json({ message: req.body.actif ? 'Utilisateur réactivé.' : 'Utilisateur désactivé.', user: publicUser(misAJour) });
  } catch (error) {
    console.error('Erreur PATCH /api/entreprise/utilisateurs/:id :', error);
    res.status(500).json({ error: 'Impossible de mettre à jour cet utilisateur.' });
  }
});

export default router;
