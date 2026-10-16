import express from 'express';
import { and, eq } from 'drizzle-orm';
import { db } from '../db.js';
import { clients, entreprises, factures, paiements, liteIdempotency, depenses } from '../schema.js';
import { createExpense } from './dépenses.js';
import { ensureIdempotencyTable } from '../middleware/idempotency.js';
import { AiError, GROQ_MODEL, GROQ_LICENSE, groqJson } from '../services/groq.js';
import { computePaymentScore, anonymousScoreSummary } from '../services/paymentScore.js';
import { validatePhoto, extractPhotoDraft, signDraft, verifyDraft, photoOperationKey, validateConfirmedDraft, probablePhotoDuplicates, photoExpenseDescription, signDuplicateReview, acceptsDuplicateReview } from '../services/photoDraft.js';

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
// Best-effort abuse control per server/isolate; provider quotas remain the hard cap.
const requests = new Map();
function quota(req) {
  const key = String(req.entrepriseId), now = Date.now();
  for (const [id, entry] of requests) if (entry.until <= now) requests.delete(id);
  const entry = requests.get(key) || { count: 0, until: now + 60000 };
  if (entry.count >= 10 || requests.size > 1000) throw new AiError('Trop de demandes IA. Réessayez dans une minute.', 429);
  entry.count++;
  requests.set(key, entry);
}
function fail(res, error) {
  return res.status(error instanceof AiError ? error.status : 500).json({
    success: false, message: error instanceof AiError ? error.message : 'Impossible de traiter la demande. Aucun nouveau résultat confirmé.',
  });
}
async function isDuplicate(entrepriseId, hash) {
  try {
    const [operation] = await db.select({ status: liteIdempotency.status }).from(liteIdempotency).where(and(
      eq(liteIdempotency.entrepriseId, entrepriseId), eq(liteIdempotency.idempotencyKey, photoOperationKey(entrepriseId, hash)),
    )).limit(1);
    return operation?.status === 'completed';
  } catch (error) {
    // Existing Lite installations create this table on their first write.
    if ((error.cause?.code || error.code) === '42P01') return false;
    throw error;
  }
}

async function duplicateReview(connection, draft, hash, req) {
  const expenses = await connection.select({
    id: depenses.id, description: depenses.description, montant: depenses.montant, dateDepense: depenses.dateDepense,
  }).from(depenses).where(eq(depenses.entrepriseId, req.entrepriseId));
  const matches = probablePhotoDuplicates(draft, expenses);
  return { matches, reviewToken: matches.length ? signDuplicateReview(hash, draft, matches, req.entrepriseId, req.user.id) : null };
}

router.get('/status', (_req, res) => res.json({ success: true, data: {
  configured: Boolean(process.env.GROQ_API_KEY), model: GROQ_MODEL, license: GROQ_LICENSE,
} }));

router.post('/prepare-photo', async (req, res) => {
  try {
    if (req.body.consent !== true) throw new AiError('Votre accord explicite est requis pour envoyer la photo à Groq.', 400);
    const hash = validatePhoto(req.body.image);
    quota(req);
    const duplicate = await isDuplicate(req.entrepriseId, hash);
    if (duplicate) return res.json({ success: true, data: {
      draftToken: signDraft(hash, req.entrepriseId, req.user.id),
      draft: { description: '', montant: null, dateDepense: null, reference: '', fournisseur: '', devise: '' },
      matches: [], reviewToken: null,
      warnings: ['Cette photo a déjà été enregistrée pour votre entreprise.'], duplicate: true,
    } });
    const result = await extractPhotoDraft(req.body.image);
    const review = await duplicateReview(db, result.draft, hash, req);
    // Photo bytes are neither saved nor logged, including on provider errors.
    return res.json({ success: true, data: { ...result, ...review, draftToken: signDraft(hash, req.entrepriseId, req.user.id), duplicate: false } });
  } catch (error) { return fail(res, error); }
});

router.post('/confirm', async (req, res) => {
  try {
    if (req.body.confirmed !== true) throw new AiError('Confirmez explicitement les données avant de les enregistrer.', 400);
    const hash = verifyDraft(req.body.draftToken, req.entrepriseId, req.user.id);
    const draft = validateConfirmedDraft(req.body.draft);
    const [company] = await db.select({ devise: entreprises.devise }).from(entreprises).where(eq(entreprises.id, req.entrepriseId)).limit(1);
    if (!company) throw new AiError('Entreprise introuvable.', 404);
    const currency = value => ['XOF', 'CFA', 'FCFA'].includes(value.toUpperCase()) ? 'XOF' : value.toUpperCase();
    if (currency(draft.devise) !== currency(company.devise || 'FCFA')) {
      throw new AiError(`La pièce doit être exprimée dans la devise comptable ${company.devise || 'FCFA'}. Aucune conversion automatique.`, 400);
    }
    await ensureIdempotencyTable();
    // Server-owned key is stable for the image across users, reloads and retries.
    // Existing expense transaction atomically claims it and writes expense/audit.
    req.idempotencyKey = photoOperationKey(req.entrepriseId, hash);
    const { duplicateChoice, reviewToken } = req.body;
    // Executed after atomic replay detection, before any expense/category/audit
    // insert. The company row lock serializes concurrent expense confirmations.
    req.beforeCreateExpense = async tx => {
      const review = await duplicateReview(tx, draft, hash, req);
      if (review.matches.length && !acceptsDuplicateReview(duplicateChoice, reviewToken, hash, draft, review.matches, req.entrepriseId, req.user.id)) {
        const error = new AiError('Des dépenses correspondent à cette pièce. Choisissez explicitement de conserver l’existant ou de créer une dépense distincte.', 409);
        error.details = { code: 'PHOTO_DUPLICATES', ...review };
        throw error;
      }
    };
    req.body = {
      description: photoExpenseDescription(draft),
      montant: draft.montant, dateDepense: draft.dateDepense,
    };
    return createExpense(req, res);
  } catch (error) { return fail(res, error); }
});

router.post('/payment-analysis/:clientId', async (req, res) => {
  try {
    const id = Number(req.params.clientId);
    if (!Number.isSafeInteger(id) || id <= 0 || (req.body.explain !== undefined && typeof req.body.explain !== 'boolean')) throw new AiError('Client ou demande invalide.', 400);
    const [client] = await db.select({ id: clients.id }).from(clients).where(and(eq(clients.id, id), eq(clients.entrepriseId, req.entrepriseId))).limit(1);
    if (!client) throw new AiError('Client introuvable.', 404);
    const invoices = await db.select({
      id: factures.id, statut: factures.statut, dateFacture: factures.dateFacture, dateEcheance: factures.dateEcheance,
      totalTTC: factures.totalTTC, montantPaye: factures.montantPaye, soldeRestant: factures.soldeRestant,
    }).from(factures).where(and(eq(factures.entrepriseId, req.entrepriseId), eq(factures.clientId, id)));
    const payments = await db.select({
      factureId: paiements.factureId, montant: paiements.montant, datePaiement: paiements.datePaiement,
    }).from(paiements).innerJoin(factures, and(eq(factures.id, paiements.factureId), eq(factures.entrepriseId, req.entrepriseId), eq(factures.clientId, id)))
      .where(eq(paiements.entrepriseId, req.entrepriseId));
    const score = computePaymentScore(invoices, payments);
    let explanation = null, explanationError = null;
    if (req.body.explain === true && score.score !== null) {
      try {
        quota(req);
        const result = await groqJson([
          { role: 'system', content: 'Explique en français uniquement les indicateurs fournis, sans recalculer ni modifier le score. Aucune décision ni recommandation de crédit, aucun jugement sur la personne. Signale les limites d’un petit échantillon. Retourne JSON {"explanation":"texte de 150 mots maximum"}. Les montants et identités sont volontairement absents.' },
          { role: 'user', content: JSON.stringify(anonymousScoreSummary(score)) },
        ], { schema: {
          type: 'object', additionalProperties: false,
          properties: { explanation: { type: 'string' } }, required: ['explanation'],
        } });
        if (typeof result.explanation !== 'string' || !result.explanation.trim()) throw new AiError('Explication Groq invalide.');
        explanation = result.explanation.trim().slice(0, 2500);
      } catch (error) { explanationError = error instanceof AiError ? error.message : 'Explication indisponible. Le calcul reste consultable.'; }
    }
    return res.json({ success: true, data: { ...score, explanation, explanationError } });
  } catch (error) { return fail(res, error); }
});
export default router;
