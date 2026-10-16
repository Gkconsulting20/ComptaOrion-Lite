import express from 'express';
import { db } from '../db.js';
import crypto from 'crypto';
import { users, sessions, auditConnexions, passwordResetTokens, permissions } from '../schema.js';
import { generateToken, generateRefreshToken, verifyRefreshToken, hashPassword, comparePassword, authMiddleware } from '../auth.js';
import { eq, and, gt, isNull } from 'drizzle-orm';

const router = express.Router();

// ==========================================
// LOGIN + SESSION MANAGEMENT
// ==========================================

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    // Chercher l'utilisateur par email (insensible à la casse)
    const emailLower = email?.toLowerCase().trim();
    
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, emailLower));

    if (!user) {
      await db.insert(auditConnexions).values({
        userId: null,
        enterpriseId: null,
        type: 'failed_login',
        ipAddress,
        userAgent,
        statut: 'failed',
        raison: 'Email non trouvé'
      });
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const passwordMatch = await comparePassword(password, user.passwordHash);
    if (!passwordMatch) {
      await db.insert(auditConnexions).values({
        userId: user.id,
        enterpriseId: user.entrepriseId,
        type: 'failed_login',
        ipAddress,
        userAgent,
        statut: 'failed',
        raison: 'Mot de passe incorrect'
      });
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const token = generateToken(user);
    const refreshToken = generateRefreshToken(user);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Créer session avec l'entrepriseId de l'utilisateur trouvé
    const session = await db.insert(sessions).values({
      userId: user.id,
      enterpriseId: user.entrepriseId,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      refreshTokenHash: crypto.createHash('sha256').update(refreshToken).digest('hex'),
      ipAddress,
      userAgent,
      expiresAt
    }).returning();

    // Audit login réussi
    await db.insert(auditConnexions).values({
      userId: user.id,
      enterpriseId: user.entrepriseId,
      type: 'login',
      ipAddress,
      userAgent,
      statut: 'success'
    });

    res.json({
      message: 'Connexion réussie',
      user: {
        id: user.id,
        email: user.email,
        nom: user.nom,
        prenom: user.prenom,
        role: user.role,
        entrepriseId: user.entrepriseId
      },
      token,
      refreshToken,
      session: { id: session[0].id, expiresAt }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/logout', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID requis' });
    }

    const session = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.id, parseInt(sessionId)),
        eq(sessions.userId, req.user.id),
        eq(sessions.enterpriseId, req.user.entrepriseId)
      )
    });

    if (!session) {
      return res.status(403).json({ error: 'Session non autorisée ou introuvable' });
    }

    await db.update(sessions).set({
      logoutAt: new Date()
    }).where(eq(sessions.id, parseInt(sessionId)));

    await db.insert(auditConnexions).values({
      userId: req.user.id,
      enterpriseId: req.user.entrepriseId,
      type: 'logout',
      ipAddress,
      userAgent: req.get('user-agent'),
      statut: 'success'
    });

    res.json({ message: 'Déconnexion réussie' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// REFRESH TOKEN
// ==========================================

router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const decoded = verifyRefreshToken(refreshToken);

    if (!decoded) {
      return res.status(401).json({ error: 'Refresh token invalide ou expiré' });
    }

    const user = await db.query.users.findFirst({
      where: eq(users.id, decoded.id)
    });

    if (!user) {
      return res.status(401).json({ error: 'Utilisateur non trouvé' });
    }

    const refreshTokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    
    const session = await db.query.sessions.findFirst({
      where: and(
        eq(sessions.userId, user.id),
        eq(sessions.refreshTokenHash, refreshTokenHash),
        gt(sessions.expiresAt, new Date())
      )
    });

    if (!session) {
      return res.status(401).json({ error: 'Session invalide ou expirée' });
    }

    const newToken = generateToken(user);
    const newRefreshToken = generateRefreshToken(user);
    const newRefreshTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');

    await db.update(sessions).set({
      tokenHash: crypto.createHash('sha256').update(newToken).digest('hex'),
      refreshTokenHash: newRefreshTokenHash
    }).where(eq(sessions.id, session.id));

    await db.insert(auditConnexions).values({
      userId: user.id,
      enterpriseId: user.entrepriseId,
      type: 'token_refresh',
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      statut: 'success'
    });

    res.json({
      message: 'Token rafraîchi',
      token: newToken,
      refreshToken: newRefreshToken
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// RÉCUPÉRATION MOT DE PASSE
// ==========================================

router.post('/forgot-password', async (req, res) => {
  try {
    const { email, entrepriseId } = req.body;

    const user = await db.query.users.findFirst({
      where: and(
        eq(users.email, email),
        eq(users.entrepriseId, parseInt(entrepriseId))
      )
    });

    if (!user) {
      return res.status(200).json({ message: 'Si l\'email existe, un lien de réinitialisation a été envoyé' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1h

    await db.insert(passwordResetTokens).values({
      userId: user.id,
      token: resetToken,
      expiresAt
    });

    // TODO: Envoyer email avec lien de réinitialisation
    // const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:5000'}/reset-password?token=${resetToken}`;
    // await sendEmail(user.email, 'Réinitialisation de mot de passe', resetLink);

    res.json({
      message: 'Si l\'email existe, un lien de réinitialisation a été envoyé à votre adresse'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    const resetToken = await db.query.passwordResetTokens.findFirst({
      where: and(
        eq(passwordResetTokens.token, token),
        gt(passwordResetTokens.expiresAt, new Date())
      )
    });

    if (!resetToken) {
      return res.status(400).json({ error: 'Jeton invalide ou expiré' });
    }

    const hashedPassword = await hashPassword(newPassword);

    await db.update(users).set({
      passwordHash: hashedPassword
    }).where(eq(users.id, resetToken.userId));

    await db.update(passwordResetTokens).set({
      usedAt: new Date()
    }).where(eq(passwordResetTokens.id, resetToken.id));

    res.json({ message: 'Mot de passe réinitialisé avec succès' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// GESTION SESSIONS
// ==========================================

router.get('/sessions', authMiddleware, async (req, res) => {
  try {
    const userSessions = await db.query.sessions.findMany({
      where: and(
        eq(sessions.userId, req.user.id),
        isNull(sessions.logoutAt)
      )
    });

    res.json(userSessions.map(s => ({
      id: s.id,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/sessions/:sessionId', authMiddleware, async (req, res) => {
  try {
    await db.update(sessions).set({
      logoutAt: new Date()
    }).where(eq(sessions.id, parseInt(req.params.sessionId)));

    res.json({ message: 'Session fermée' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// PERMISSIONS RBAC
// ==========================================

router.get('/permissions', authMiddleware, async (req, res) => {
  try {
    const allPermissions = await db.query.permissions.findMany();
    
    // Transformer en format attendu par le frontend
    const permissionsGrouped = {};
    allPermissions.forEach(perm => {
      const key = `${perm.role}_${perm.module}`;
      if (!permissionsGrouped[key]) {
        permissionsGrouped[key] = {
          id: perm.id,
          role: perm.role,
          module: perm.module,
          canRead: false,
          canWrite: false,
          canDelete: false,
          canAdmin: false
        };
      }
      if (perm.action === 'read' && perm.autorise) permissionsGrouped[key].canRead = true;
      if (perm.action === 'create' && perm.autorise) permissionsGrouped[key].canWrite = true;
      if (perm.action === 'update' && perm.autorise) permissionsGrouped[key].canWrite = true;
      if (perm.action === 'delete' && perm.autorise) permissionsGrouped[key].canDelete = true;
      if (perm.action === 'admin' && perm.autorise) permissionsGrouped[key].canAdmin = true;
    });

    res.json(Object.values(permissionsGrouped));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/permissions/:permissionId', authMiddleware, async (req, res) => {
  try {
    const { canRead, canWrite, canDelete, canAdmin } = req.body;
    const permId = parseInt(req.params.permissionId);

    // Récupérer la permission pour obtenir le rôle et module
    const perm = await db.query.permissions.findFirst({
      where: eq(permissions.id, permId)
    });

    if (!perm) {
      return res.status(404).json({ error: 'Permission non trouvée' });
    }

    // Mettre à jour les permissions correspondantes
    if (canRead !== undefined) {
      await db.update(permissions).set({ autorise: canRead })
        .where(and(
          eq(permissions.role, perm.role),
          eq(permissions.module, perm.module),
          eq(permissions.action, 'read')
        ));
    }
    if (canWrite !== undefined) {
      await db.update(permissions).set({ autorise: canWrite })
        .where(and(
          eq(permissions.role, perm.role),
          eq(permissions.module, perm.module),
          eq(permissions.action, 'create')
        ));
      await db.update(permissions).set({ autorise: canWrite })
        .where(and(
          eq(permissions.role, perm.role),
          eq(permissions.module, perm.module),
          eq(permissions.action, 'update')
        ));
    }
    if (canDelete !== undefined) {
      await db.update(permissions).set({ autorise: canDelete })
        .where(and(
          eq(permissions.role, perm.role),
          eq(permissions.module, perm.module),
          eq(permissions.action, 'delete')
        ));
    }

    res.json({ message: 'Permission mise à jour' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// AUDIT CONNEXIONS
// ==========================================

router.get('/audit', authMiddleware, async (req, res) => {
  try {
    const { limit = 100 } = req.query;

    const audits = await db.query.auditConnexions.findMany({
      where: eq(auditConnexions.userId, req.user.id),
      limit: parseInt(limit)
    });

    res.json(audits);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
