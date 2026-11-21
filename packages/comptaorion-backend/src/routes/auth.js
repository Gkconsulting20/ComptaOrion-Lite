import express from 'express';
import { db } from '../db.js';
import { users, entreprises, saasClients, saasCommerciaux } from '../schema.js';
import { and, eq, sql } from 'drizzle-orm';
import {
  generateToken,
  generateRefreshToken,
  hashPassword,
  comparePassword,
  verifyRefreshToken,
  verifyToken,
} from '../auth.js';
import { initializeSyscohadaForEnterprise } from '../services/syscohadaService.js';
import { evaluateSaasAccess, getSaasAccess } from '../trial-access.js';
import { normaliserTauxTva, TAUX_TVA_DEFAUT } from '../utils/tva.js';

const router = express.Router();

/**
 * POST /auth/register
 * Inscription d'un nouvel utilisateur + création d'entreprise
 */
router.post('/register', async (req, res) => {
  try {
    const {
      username,
      email,
      password,
      nom,
      prenom,
      entrepriseNom,
      entrepriseAdresse,
      entrepriseTelephone,
      entrepriseEmail,
      tauxTva: tauxTvaDemande,
      entrepriseTauxTva: tauxTvaDemandeAlias,
      commercialId: referralCommercialId,
    } = req.body;

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedUsername = String(username || '').trim();
    if (!normalizedUsername || !normalizedEmail || typeof password !== 'string') {
      return res.status(400).json({ error: 'Champs requis: username, email, password' });
    }
    if (normalizedUsername.length < 3 || normalizedUsername.length > 80) {
      return res.status(400).json({ error: 'Le nom d’utilisateur doit contenir entre 3 et 80 caractères.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Adresse email invalide.' });
    }
    if (password.length < 12 || new TextEncoder().encode(password).length > 72) {
      return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 12 caractères et au maximum 72 octets.' });
    }

    // Taux de TVA choisi à la création de l'entreprise (décision Cap, 21 nov. 2026) :
    // 0 % (exonéré), 18 % ou taux personnalisé (0 à 100). Défaut 18 % si non renseigné.
    // 0 est une valeur valide : on distingue « non renseigné » de « invalide ».
    let tauxTvaEntreprise = TAUX_TVA_DEFAUT;
    const tauxTvaChoisi = tauxTvaDemande ?? tauxTvaDemandeAlias;
    if (tauxTvaChoisi !== undefined && tauxTvaChoisi !== null && tauxTvaChoisi !== '') {
      const tauxNormalise = normaliserTauxTva(tauxTvaChoisi);
      if (tauxNormalise === null) {
        return res.status(400).json({ error: 'Le taux de TVA doit être entre 0 et 100.' });
      }
      tauxTvaEntreprise = tauxNormalise;
    }

    // Vérifier si l'utilisateur existe déjà
    const [existingUser] = await db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalizedEmail}`);

    if (existingUser) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    }
    const [existingUsername] = await db.select({ id: users.id })
      .from(users)
      .where(eq(users.username, normalizedUsername))
      .limit(1);
    if (existingUsername) {
      return res.status(400).json({ error: 'Ce nom d’utilisateur est déjà utilisé.' });
    }

    let referralCommercial = null;
    if (referralCommercialId !== undefined && referralCommercialId !== null && referralCommercialId !== '') {
      const parsedCommercialId = Number(referralCommercialId);
      if (!Number.isSafeInteger(parsedCommercialId) || parsedCommercialId < 1) {
        return res.status(400).json({ error: 'Lien de commercial invalide.' });
      }
      [referralCommercial] = await db.select({ id: saasCommerciaux.id })
        .from(saasCommerciaux)
        .where(and(eq(saasCommerciaux.id, parsedCommercialId), eq(saasCommerciaux.actif, true)))
        .limit(1);
      if (!referralCommercial) return res.status(400).json({ error: 'Ce lien commercial n’est plus disponible.' });
    }

    const passwordHash = await hashPassword(password);
    const { newEntreprise, newUser, newSaasClient } = await db.transaction(async (tx) => {
      const [createdEntreprise] = await tx.insert(entreprises)
        .values({
          nom: entrepriseNom || `Entreprise de ${nom || normalizedUsername}`,
          adresse: entrepriseAdresse,
          telephone: entrepriseTelephone,
          email: entrepriseEmail || normalizedEmail,
          tauxTva: tauxTvaEntreprise.toFixed(2),
          actif: true,
        })
        .returning();
      const [createdUser] = await tx.insert(users)
        .values({
          entrepriseId: createdEntreprise.id,
          username: normalizedUsername,
          email: normalizedEmail,
          passwordHash,
          nom,
          prenom,
          role: 'admin',
          actif: true,
        })
        .returning();
      const [createdSaasClient] = await tx.insert(saasClients).values({
        entrepriseId: createdEntreprise.id,
        commercialId: referralCommercial?.id || null,
        statut: 'trial',
        source: referralCommercial ? 'commercial' : 'web',
        notes: referralCommercial ? `Inscription via le lien du commercial #${referralCommercial.id}` : null,
      }).returning();
      return { newEntreprise: createdEntreprise, newUser: createdUser, newSaasClient: createdSaasClient };
    });
    const trialAccess = evaluateSaasAccess(newSaasClient);

    // Initialiser automatiquement le plan comptable SYSCOHADA
    try {
      const syscohadaResult = await initializeSyscohadaForEnterprise(newEntreprise.id);
      console.log(`Plan comptable SYSCOHADA initialisé pour entreprise ${newEntreprise.id}:`, syscohadaResult);
    } catch (syscohadaError) {
      console.error('Erreur initialisation SYSCOHADA:', syscohadaError.message);
    }

    // Générer les tokens
    const token = generateToken(newUser);
    const refreshToken = generateRefreshToken(newUser);

    res.status(201).json({
      message: 'Inscription réussie',
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        nom: newUser.nom,
        prenom: newUser.prenom,
        role: newUser.role,
        entrepriseId: newUser.entrepriseId,
        trialEndsAt: trialAccess.trialEndsAt,
      },
      entreprise: newEntreprise,
      token,
      refreshToken,
    });
  } catch (error) {
    console.error('Erreur lors de l\'inscription:', error);
    res.status(500).json({ error: 'Erreur serveur lors de l\'inscription' });
  }
});

/**
 * POST /auth/login
 * Connexion d'un utilisateur
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    // Trouver l'utilisateur
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));

    if (!user) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    // Vérifier si l'utilisateur est actif
    if (!user.actif) {
      return res.status(403).json({ error: 'Compte désactivé' });
    }

    // Comparer le mot de passe
    const isValid = await comparePassword(password, user.passwordHash);

    if (!isValid) {
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }
    if (!user.actif) return res.status(403).json({ error: 'Compte désactivé', code: 'ACCOUNT_INACTIVE' });
    const saasAccess = await getSaasAccess(user.entrepriseId, user);
    if (!saasAccess.allowed) {
      return res.status(403).json({
        code: saasAccess.code,
        error: saasAccess.code === 'TRIAL_EXPIRED'
          ? 'La période d’essai est terminée. Contactez ComptaOrion pour réactiver votre accès.'
          : 'Cet espace est suspendu ou désactivé. Contactez ComptaOrion.',
        trialEndsAt: saasAccess.trialEndsAt,
      });
    }

    // Mettre à jour la dernière connexion
    await db
      .update(users)
      .set({ lastLogin: new Date() })
      .where(eq(users.id, user.id));

    // Récupérer les infos de l'entreprise
    const [entreprise] = await db
      .select()
      .from(entreprises)
      .where(eq(entreprises.id, user.entrepriseId));

    // Générer les tokens
    const token = generateToken(user);
    const refreshToken = generateRefreshToken(user);

    res.json({
      message: 'Connexion réussie',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        nom: user.nom,
        prenom: user.prenom,
        role: user.role,
        entrepriseId: user.entrepriseId,
        trialEndsAt: saasAccess.trialEndsAt,
      },
      entreprise,
      token,
      refreshToken,
    });
  } catch (error) {
    console.error('Erreur lors de la connexion:', error);
    res.status(500).json({ error: 'Erreur serveur lors de la connexion' });
  }
});

/**
 * POST /auth/refresh
 * Rafraîchir le token d'accès
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token requis' });
    }

    // Vérifier le refresh token
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded) {
      return res.status(401).json({ error: 'Refresh token invalide ou expiré' });
    }

    // Récupérer l'utilisateur
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, decoded.id));

    if (!user || !user.actif) {
      return res.status(401).json({ error: 'Utilisateur introuvable ou inactif' });
    }
    const saasAccess = await getSaasAccess(user.entrepriseId, user);
    if (!saasAccess.allowed) {
      return res.status(403).json({ code: saasAccess.code, error: 'La période d’essai est terminée.' });
    }

    // Générer un nouveau token
    const newToken = generateToken(user);

    res.json({
      token: newToken,
    });
  } catch (error) {
    console.error('Erreur lors du refresh:', error);
    res.status(500).json({ error: 'Erreur serveur lors du refresh' });
  }
});

/**
 * GET /auth/me
 * Récupérer les infos de l'utilisateur connecté
 */
router.get('/me', async (req, res) => {
  try {
    // Vérifier le token
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    const token = authHeader.substring(7);
    const decoded = verifyToken(token);

    if (!decoded) {
      return res.status(401).json({ error: 'Token invalide' });
    }

    // Récupérer l'utilisateur
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, decoded.id));

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }
    if (!user.actif) return res.status(403).json({ error: 'Compte désactivé', code: 'ACCOUNT_INACTIVE' });
    const saasAccess = await getSaasAccess(user.entrepriseId, user);
    if (!saasAccess.allowed) {
      return res.status(403).json({
        code: saasAccess.code,
        error: saasAccess.code === 'TRIAL_EXPIRED'
          ? 'La période d’essai est terminée. Contactez ComptaOrion pour réactiver votre accès.'
          : 'Cet espace est suspendu ou désactivé. Contactez ComptaOrion.',
        trialEndsAt: saasAccess.trialEndsAt,
      });
    }

    // Récupérer l'entreprise
    const [entreprise] = await db
      .select()
      .from(entreprises)
      .where(eq(entreprises.id, user.entrepriseId));

    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        nom: user.nom,
        prenom: user.prenom,
        role: user.role,
        entrepriseId: user.entrepriseId,
        trialEndsAt: saasAccess.trialEndsAt,
      },
      entreprise,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération du profil:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
