import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePaymentScore, anonymousScoreSummary } from '../src/services/paymentScore.js';
import { validatePhoto, cleanDraft, validateConfirmedDraft, signDraft, verifyDraft, photoOperationKey, extractPhotoDraft } from '../src/services/photoDraft.js';
import { groqJson, checkGroqModel, GROQ_MODEL } from '../src/services/groq.js';

const now = new Date('2026-10-16T12:00:00Z');
const invoice = (overrides = {}) => ({
  id: 1, statut: 'envoyee', dateFacture: '2026-09-01', dateEcheance: '2026-10-01',
  totalTTC: '100', montantPaye: '0', soldeRestant: '100', ...overrides,
});
const payment = (overrides = {}) => ({ factureId: 1, montant: '100', datePaiement: '2026-09-30', ...overrides });
const fixtureKey = 'public-unit-test-fixture-not-for-production';
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';

test('le score ne donne pas 100 à un client sans historique, sans échéance ou non encore échu', () => {
  assert.equal(computePaymentScore([], [], now).score, null);
  assert.equal(computePaymentScore([invoice({ dateEcheance: null })], [], now).score, null);
  assert.equal(computePaymentScore([invoice({ dateEcheance: '2026-11-01' })], [], now).score, null);
});
test('un paiement intégral ponctuel donne 100 avec une réserve sur le petit échantillon', () => {
  const result = computePaymentScore([invoice({ montantPaye: '100', soldeRestant: '0', statut: 'payee' })], [payment()], now);
  assert.equal(result.score, 100);
  assert.equal(result.coverage, 'limitée');
  assert.deepEqual(result.components, { repayment: 50, punctuality: 30, delay: 20 });
});
test('les impayés et les retards contribuent de manière transparente', () => {
  const result = computePaymentScore([invoice()], [], now);
  assert.equal(result.score, 15);
  assert.equal(result.overdueAmount, 100);
  assert.equal(result.averageDelayDays, 15);
  assert.equal(result.components.punctuality, 0);
});
test('le retard de paiement utilise la date de règlement complet, pas celle du premier versement', () => {
  const result = computePaymentScore([invoice({ montantPaye: '100', soldeRestant: '0' })], [
    payment({ montant: '40' }), payment({ montant: '60', datePaiement: '2026-10-11' }),
  ], now);
  assert.equal(result.averageDelayDays, 10);
  assert.equal(result.score, 67);
});
test('un paiement partiel non soldé n’est jamais considéré ponctuel', () => {
  const result = computePaymentScore([invoice({ montantPaye: '50', soldeRestant: '50' })], [payment({ montant: '50' })], now);
  assert.equal(result.score, 40);
  assert.equal(result.totalPaid, 50);
});
test('brouillons, annulations, dates impossibles et historiques incohérents sont exclus', () => {
  for (const overrides of [
    { statut: 'brouillon' }, { statut: 'annulee' }, { dateEcheance: '2026-02-30' },
    { dateFacture: '2026-12-01' }, { totalTTC: '-5' }, { montantPaye: '100', soldeRestant: '0' },
  ]) assert.equal(computePaymentScore([invoice(overrides)], [], now).score, null);
  assert.equal(computePaymentScore([invoice()], [payment({ datePaiement: '2026-10-20' })], now).score, 15);
});
test('le score reste borné après un long retard et utilise tout l’historique fourni', () => {
  const rows = Array.from({ length: 150 }, (_, id) => invoice({ id, dateEcheance: '2026-09-01' }));
  const result = computePaymentScore(rows, [], new Date('2027-01-01'));
  assert.equal(result.score, 0);
  assert.equal(result.eligibleCount, 150);
  assert.equal(result.coverage, 'établie');
});
test('l’explication utilise une liste blanche excluant identité, montants et numéros de facture', () => {
  const summary = anonymousScoreSummary({ ...computePaymentScore([invoice()], [], now), nom: 'Secret Client', telephone: '1234' });
  const text = JSON.stringify(summary);
  assert.doesNotMatch(text, /Secret Client|1234|totalPaid|outstanding|asOf|totalInvoiced/);
  assert.equal(summary.score, 15);
});
test('validation photo : contenu, taille et type; aucune URL distante n’est acceptée', () => {
  assert.match(validatePhoto(image), /^[a-f0-9]{64}$/);
  for (const invalid of ['https://example.com/receipt.png', 'data:image/svg+xml;base64,AAAA', image.replace('png', 'jpeg'), 'data:image/png;base64,YWJj']) {
    assert.throws(() => validatePhoto(invalid), e => e.status === 400);
  }
  const large = `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64')}`;
  assert.throws(() => validatePhoto(large), e => e.status === 413);
});
test('les champs incertains restent vides; la confirmation exige des valeurs valides', () => {
  assert.deepEqual(cleanDraft({ montant: '123', dateDepense: '2026-02-30', irrelevant: true }), {
    montant: null, dateDepense: null, description: '', reference: '', devise: '',
  });
  assert.throws(() => validateConfirmedDraft({ description: 'Transport', montant: Infinity, dateDepense: '2026-10-16' }), e => e.status === 400);
  assert.equal(validateConfirmedDraft({ description: 'Transport', montant: 123, dateDepense: '2026-10-16', devise: 'FCFA' }).montant, 123);
});
test('le brouillon signé est lié à l’entreprise et à l’utilisateur; altérations interdites', () => {
  const hash = validatePhoto(image);
  const token = signDraft(hash, 2, 7, fixtureKey);
  assert.equal(verifyDraft(token, 2, 7, fixtureKey), hash);
  assert.throws(() => verifyDraft(token, 3, 7, fixtureKey), e => e.status === 403);
  assert.throws(() => verifyDraft(token, 2, 8, fixtureKey), e => e.status === 403);
  assert.throws(() => verifyDraft(`${token}tamper`, 2, 7, fixtureKey), e => e.status === 403);
  assert.notEqual(photoOperationKey(2, hash), photoOperationKey(3, hash));
  assert.equal(photoOperationKey(2, hash), photoOperationKey(2, hash));
});
test('Groq ne change jamais de modèle vers OpenAI et refuse un modèle absent', async () => {
  await assert.rejects(checkGroqModel({ key: fixtureKey, fetcher: async () => Response.json({ data: [{ id: 'openai/gpt-oss-20b', active: true }] }) }), e => e.status === 503);
});
test('la photo est transmise uniquement dans le message utilisateur, sans identités ou liste clients', async () => {
  const calls = [];
  const options = { key: fixtureKey, fetcher: async (url, init) => {
    calls.push({ url, body: init.body && JSON.parse(init.body) });
    return url.endsWith('/models') ? Response.json({ data: [{ id: GROQ_MODEL, active: true }] })
      : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ description: 'Transport', montant: 5000, dateDepense: '2026-10-16', devise: 'FCFA', reference: 'R1', warnings: [] }) } }] });
  } };
  const result = await extractPhotoDraft(image, options);
  assert.equal(result.draft.montant, 5000);
  assert.equal(calls[1].body.model, GROQ_MODEL);
  assert.equal(calls[1].body.messages[1].content[1].image_url.url, image);
  assert.doesNotMatch(JSON.stringify(calls[1].body), /entrepriseId|userId|api_key/);
});
test('absence de clé, quotas, indisponibilité et JSON invalide échouent explicitement sans exposer le fournisseur', async () => {
  await assert.rejects(checkGroqModel({ key: '' }), e => e.status === 503);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(checkGroqModel({ key: fixtureKey, fetcher: async () => Response.json({ error: { message: 'private receipt' } }, { status }) }), e => !e.message.includes('private receipt'));
  }
  await assert.rejects(checkGroqModel({ key: fixtureKey, fetcher: async () => { throw new Error('private key'); } }), e => e.status === 504 && !e.message.includes('private key'));
  await assert.rejects(groqJson([], { key: fixtureKey, fetcher: async url => url.endsWith('/models') ? Response.json({ data: [{ id: GROQ_MODEL }] }) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'invalid' } }] }) }), /invalide/);
});
