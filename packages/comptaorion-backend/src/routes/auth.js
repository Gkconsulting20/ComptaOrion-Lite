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
import { getSaasAccess } from '../trial-access.js';
import { normaliserTauxTva, TAUX_TVA_DEFAUT } from '../utils/tva.js';
import emailService from '../services/emailService.js';
import {
  checkResendAllowed,
  correctUnverifiedEmail,
  createVerificationCode,
  findUserByEmail,
  getBlockedUntilForEmail,
  getResendState,
  isEmailVerificationRequired,
  markEmailVerifiedAndStartTrial,
  verifyEmailCode,
} from '../services/emailVerification.js';

const router = express.Router();

// Crée un code à 6 chiffres pour l'utilisateur et l'envoie par e-mail
// (webhook Make). Le code n'est jamais journalisé en clair. Si l'envoi
// échoue (MAKE_WEBHOOK_URL absente, par exemple), l'inscription aboutit
// quand même : le code reste renvoyable quand le secret est remis.
// Retourne { envoye, erreur }.
async function envoyerCodeVerification({ user, email, nomEntreprise, entrepriseId, isFedapay = false }) {
  try {
    const { code } = await createVerificationCode(db, { userId: user.id, email });
    const result = await emailService.sendVerificationCodeEmail({
      to: email,
      code,
      nomEntreprise,
      entrepriseId,
      userId: user.id,
      isFedapay,
    });
    if (!result.success) {
      console.error('❌ Code de vérification non envoyé à', email, ':', result.error || result.message);
      return { envoye: false, erreur: result.error || result.message };
    }
    return { envoye: true, erreur: null };
  } catch (error) {
    console.error('❌ Erreur création/envoi du code de vérification :', error?.message);
    return { envoye: false, erreur: error?.message };
  }
}

// Message générique : ne révèle jamais si l'e-mail existe.
const CODE_INVALIDE_MESSAGE = 'Code invalide ou expiré.';

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
    // Initialiser automatiquement le plan comptable SYSCOHADA
    try {
      const syscohadaResult = await initializeSyscohadaForEnterprise(newEntreprise.id);
      console.log(`Plan comptable SYSCOHADA initialisé pour entreprise ${newEntreprise.id}:`, syscohadaResult);
    } catch (syscohadaError) {
      console.error('Erreur initialisation SYSCOHADA:', syscohadaError.message);
    }

    // Vérification de l'e-mail (28 nov. 2026) : le compte est créé mais ne
    // peut pas se connecter tant que l'adresse n'est pas vérifiée. L'essai
    // de 30 jours ne démarre qu'à la vérification (la date d'inscription
    // SaaS est alors réinitialisée). L'envoi du code ne fait jamais
    // échouer l'inscription : sans MAKE_WEBHOOK_URL, le code est créé en
    // base et reste renvoyable quand le secret est remis. Aucun jeton
    // n'est retourné avant la vérification.
    const codeEnvoi = await envoyerCodeVerification({
      user: newUser,
      email: normalizedEmail,
      nomEntreprise: newEntreprise.nom,
      entrepriseId: newEntreprise.id,
    });

    res.status(201).json({
      message: codeEnvoi.envoye
        ? 'Votre espace est créé. Un code de vérification à 6 chiffres vient d’être envoyé à ' + normalizedEmail + ' (valable 15 minutes). Saisissez-le pour activer votre compte : votre essai gratuit de 30 jours démarrera alors.'
        : 'Votre espace est créé, mais l’e-mail de vérification n’a pas pu être envoyé pour le moment. Demandez un nouveau code depuis la page de vérification.',
      emailVerificationRequired: true,
      emailSent: codeEnvoi.envoye,
      email: normalizedEmail,
      user: {
        id: newUser.id,
        username: newUser.username,
        email: newUser.email,
        nom: newUser.nom,
        prenom: newUser.prenom,
        role: newUser.role,
        entrepriseId: newUser.entrepriseId,
        trialEndsAt: null,
      },
      entreprise: newEntreprise,
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
    // Vérification e-mail (28 nov. 2026) : après validation du mot de passe,
    // un compte non vérifié ne peut pas se connecter. Comptes ORIONEXA
    // (entreprise 1) jamais bloqués, démos exclues par construction.
    const [userEntreprise] = await db.select({ isDemo: entreprises.isDemo })
      .from(entreprises).where(eq(entreprises.id, user.entrepriseId)).limit(1);
    if (isEmailVerificationRequired(user, { isDemoEntreprise: userEntreprise?.isDemo === true })) {
      return res.status(403).json({
        error: 'Vérifiez votre adresse e-mail avant de vous connecter. Un code à 6 chiffres vous a été envoyé.',
        code: 'EMAIL_NOT_VERIFIED',
        emailVerificationRequired: true,
      });
    }
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
        isDemo: entreprise?.isDemo ?? false,
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
 * POST /auth/verifier-email
 * Vérifier l'adresse e-mail avec le code à 6 chiffres reçu. Réponses
 * génériques : ne révèle jamais si l'e-mail existe. En cas de succès,
 * l'essai de 30 jours démarre à cet instant et les jetons JWT sont
 * retournés (l'inscription n'en retourne plus avant vérification).
 */
router.post('/verifier-email', async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !code) {
      return res.status(400).json({ error: CODE_INVALIDE_MESSAGE });
    }

    const user = await findUserByEmail(db, email);
    if (!user) return res.status(400).json({ error: CODE_INVALIDE_MESSAGE });

    if (user.emailVerifiedAt) {
      return res.json({
        success: true,
        message: 'Votre adresse e-mail est déjà vérifiée. Vous pouvez vous connecter.',
      });
    }

    const result = await verifyEmailCode(db, { user, code });
    if (!result.ok) {
      if (result.reason === 'bloque') {
        return res.status(429).json({
          error: 'Trop de tentatives. Réessayez plus tard.',
          code: 'EMAIL_BLOQUE',
        });
      }
      return res.status(400).json({ error: CODE_INVALIDE_MESSAGE });
    }

    const { trialExpiresAt } = await markEmailVerifiedAndStartTrial(db, { user });
    const [entreprise] = await db.select()
      .from(entreprises).where(eq(entreprises.id, user.entrepriseId)).limit(1);
    await db.update(users).set({ lastLogin: new Date() }).where(eq(users.id, user.id));
    const token = generateToken(user);
    const refreshToken = generateRefreshToken(user);
    return res.json({
      success: true,
      message: 'Adresse e-mail vérifiée. Votre essai gratuit de 30 jours démarre aujourd’hui.',
      trialEndsAt: trialExpiresAt ? trialExpiresAt.toISOString() : null,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        nom: user.nom,
        prenom: user.prenom,
        role: user.role,
        entrepriseId: user.entrepriseId,
        trialEndsAt: trialExpiresAt ? trialExpiresAt.toISOString() : null,
        isDemo: entreprise?.isDemo ?? false,
      },
      entreprise,
      token,
      refreshToken,
    });
  } catch (error) {
    console.error('Erreur vérification e-mail:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /auth/renvoyer-code
 * Renvoyer un code de vérification. Corps : { email, nouvelEmail? } —
 * nouvelEmail permet de corriger l'adresse avant le renvoi. Réponse
 * générique (200) quand l'e-mail est inconnu ou déjà vérifié. Limites :
 * 60 s minimum entre deux envois, 3 renvois max par heure et par e-mail,
 * blocage 1 h après 3 codes invalidés d'affilée. Sans MAKE_WEBHOOK_URL :
 * 503 explicite, le code reste renvoyable quand le secret est remis.
 */
router.post('/renvoyer-code', async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const nouvelEmail = typeof req.body?.nouvelEmail === 'string' ? req.body.nouvelEmail.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse e-mail invalide.' });
    }
    const genericOk = () =>
      res.json({ success: true, message: 'Si cette adresse est associée à un compte non vérifié, un nouveau code a été envoyé.' });

    const user = await findUserByEmail(db, email);
    if (!user || user.emailVerifiedAt) return genericOk();

    let targetEmail = email;
    if (nouvelEmail && nouvelEmail !== email) {
      const correction = await correctUnverifiedEmail(db, { user, newEmail: nouvelEmail });
      if (!correction.ok) {
        return res.status(400).json({ error: 'Cette nouvelle adresse est invalide ou déjà utilisée.' });
      }
      targetEmail = correction.email;
    }

    const blockedUntil = await getBlockedUntilForEmail(db, targetEmail);
    if (blockedUntil) {
      return res.status(429).json({
        error: 'Trop de tentatives. Réessayez plus tard.',
        code: 'EMAIL_BLOQUE',
        retryAfterSeconds: Math.ceil((blockedUntil.getTime() - Date.now()) / 1000),
      });
    }

    const resendState = await getResendState(db, targetEmail);
    const allowed = checkResendAllowed({ ...resendState, now: new Date() });
    if (!allowed.allowed) {
      return res.status(429).json({
        error: allowed.reason === 'limite-horaire'
          ? 'Limite de renvois atteinte pour cette adresse. Réessayez plus tard.'
          : 'Veuillez patienter avant de demander un nouveau code.',
        code: 'RENVOI_TROP_TOT',
        retryAfterSeconds: allowed.retryAfterSeconds,
      });
    }

    const [entreprise] = await db.select({ nom: entreprises.nom })
      .from(entreprises).where(eq(entreprises.id, user.entrepriseId)).limit(1);
    const envoi = await envoyerCodeVerification({
      user: { ...user, email: targetEmail },
      email: targetEmail,
      nomEntreprise: entreprise?.nom || '',
      entrepriseId: user.entrepriseId,
    });
    if (!envoi.envoye) {
      return res.status(503).json({
        error: 'L’envoi d’e-mail est momentanément indisponible. Réessayez dans quelques minutes : un nouveau code vous sera alors envoyé.',
        code: 'EMAIL_ENVOI_IMPOSSIBLE',
        emailSent: false,
      });
    }
    return genericOk();
  } catch (error) {
    console.error('Erreur renvoi de code:', error);
    res.status(500).json({ error: error.message });
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
        isDemo: entreprise?.isDemo ?? false,
      },
      entreprise,
    });
  } catch (error) {
    console.error('Erreur lors de la récupération du profil:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
