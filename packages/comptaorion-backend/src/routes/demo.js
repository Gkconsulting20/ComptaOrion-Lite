// Mode démo public — ComptaOrioLite (27 nov. 2026).
//
// POST /api/auth/demo — création d'une entreprise démo (publique).
// Montée sous /api/auth, déjà public : /api/public n'est PAS monté
// dans Lite (routes/public-inscription.js existe mais n'est référencé
// nulle part) et créer ce montage pour la seule démo ajouterait une
// surface publique sans bénéfice. La route renvoie
// { user: { …, trialEndsAt: null, isDemo: true }, entreprise, token,
//   refreshToken, isDemo: true } — le frontend stocke la session
// exactement comme après un login.
// POST /api/auth/demo/reset — authentifié, entreprise démo uniquement :
// supprime l'entreprise démo courante et toutes ses données, puis
// recrée une démo seedée neuve et délivre une nouvelle session.
// Le reset est exempté du compteur anti-abus (le visiteur possède
// déjà une démo ; le plafond de 5/jour ne vise que les créations
// anonymes).

import express from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../db.js';
import { entreprises } from '../schema.js';
import { authMiddleware } from '../auth.js';
import { createDemoEnterprise } from '../services/demoSeed.js';
import { deleteEnterpriseData } from '../services/trialLifecycle.js';

const router = express.Router();

function clientIp(req) {
  return req.headers['cf-connecting-ip']
    || req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || 'inconnue';
}

router.post('/demo', async (req, res) => {
  try {
    const demo = await createDemoEnterprise({
      ipAddress: clientIp(req),
      userAgent: req.get('user-agent'),
    });
    return res.status(201).json(demo);
  } catch (error) {
    const status = error?.status || 500;
    if (status >= 500) console.error('Erreur création démo:', error?.message || error);
    return res.status(status).json({
      error: status >= 500
        ? 'Impossible de créer la démonstration. Réessayez.'
        : error.message,
      ...(error?.code ? { code: error.code } : {}),
    });
  }
});

router.post('/demo/reset', authMiddleware, async (req, res) => {
  try {
    const [entreprise] = await db.select()
      .from(entreprises)
      .where(eq(entreprises.id, req.user.entrepriseId))
      .limit(1);
    if (!entreprise) return res.status(404).json({ error: 'Entreprise introuvable.' });
    if (!entreprise.isDemo) {
      return res.status(403).json({ error: 'La réinitialisation ne concerne que les entreprises de démonstration.' });
    }
    // Suppression de la démo courante (données comprises), puis
    // création d'une démo neuve. La journalisation en
    // suppressions_entreprises est faite par la purge, pas ici : un
    // reset volontaire n'est pas une suppression du cycle de vie.
    await db.transaction(async (tx) => {
      await deleteEnterpriseData(tx, entreprise.id, entreprise.email);
    });
    const demo = await createDemoEnterprise({
      ipAddress: clientIp(req),
      userAgent: req.get('user-agent'),
      countTowardLimit: false,
    });
    return res.status(201).json(demo);
  } catch (error) {
    const status = error?.status || 500;
    if (status >= 500) console.error('Erreur réinitialisation démo:', error?.message || error);
    return res.status(status).json({
      error: status >= 500
        ? 'Impossible de réinitialiser la démonstration. Réessayez.'
        : error.message,
    });
  }
});

export default router;
