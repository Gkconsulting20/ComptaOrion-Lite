import express from 'express';
import { db } from '../db.js';
import { users, entreprises } from '../schema.js';
import { eq } from 'drizzle-orm';
import {
  generateToken,
  generateRefreshToken,
  hashPassword,
  comparePassword,
  verifyRefreshToken,
  verifyToken,
} from '../auth.js';
import { initializeSyscohadaForEnterprise } from '../services/syscohadaService.js';

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
    } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Champs requis: username, email, password' });
    }

    // Vérifier si l'utilisateur existe déjà
    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));

    if (existingUser) {
      return res.status(400).json({ error: 'Cet email est déjà utilisé' });
    }

    // Créer d'abord l'entreprise
    const [newEntreprise] = await db
      .insert(entreprises)
      .values({
        nom: entrepriseNom || `Entreprise de ${nom || username}`,
        adresse: entrepriseAdresse,
        telephone: entrepriseTelephone,
        email: entrepriseEmail || email,
        actif: true,
      })
      .returning();

    // Hash du mot de passe
    const passwordHash = await hashPassword(password);

    // Créer l'utilisateur
    const [newUser] = await db
      .insert(users)
      .values({
        entrepriseId: newEntreprise.id,
        username,
        email,
        passwordHash,
        nom,
        prenom,
        role: 'admin', // Premier utilisateur = admin
        actif: true,
      })
      .returning();

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
      },
      entreprise,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération du profil:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
