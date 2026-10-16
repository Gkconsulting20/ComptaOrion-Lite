// Opt-in integration check: real Groq requests + the configured independent
// Lite development DB, in a local Worker. Never deploys. Creates only a fresh
// synthetic tenant and removes its own rows at the end.
// Usage: node scripts/check-ai-worker.mjs generated-artifacts/test-receipt.png
// Receipt fixture: purchase receipt, 5000 FCFA, dated 2026-10-16.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { unstable_dev } from 'wrangler';
import { Miniflare, Response as WorkerResponse, convertV4MiniflareOptions } from 'miniflare';
import { initializeDatabase } from '../packages/comptaorion-backend/src/db.js';
import { generateToken } from '../packages/comptaorion-backend/src/auth.js';

for (const name of ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'GROQ_API_KEY']) {
  assert.ok(process.env[name], `${name} must be configured (value never logged)`);
}
assert.ok(process.argv[2], 'Supply a synthetic receipt PNG, never a real customer document.');
const png = await readFile(process.argv[2]);
const image = `data:image/png;base64,${png.toString('base64')}`;
const { pool } = initializeDatabase();
const directory = await mkdtemp(path.join(tmpdir(), 'lite-ai-worker-'));
let worker, companyId;
const nodeEgress = process.argv.includes('--node-egress');
try {
  const suffix = randomUUID();
  const company = await pool.query('INSERT INTO entreprises (nom, devise) VALUES ($1, $2) RETURNING id', [`AI Worker QA ${suffix}`, 'FCFA']);
  companyId = company.rows[0].id;
  const user = (await pool.query(
    'INSERT INTO users (entreprise_id, username, email, password_hash, role, actif) VALUES ($1, $2, $3, $4, $5, false) RETURNING id',
    [companyId, `ai-worker-${suffix}`, `ai-worker-${suffix}@example.invalid`, 'disabled-synthetic-account', 'admin'],
  )).rows[0];
  const client = (await pool.query('INSERT INTO clients (entreprise_id, nom) VALUES ($1, $2) RETURNING id', [companyId, 'Synthetic payment history'])).rows[0];
  const noHistory = (await pool.query('INSERT INTO clients (entreprise_id, nom) VALUES ($1, $2) RETURNING id', [companyId, 'Synthetic no history'])).rows[0];
  const invoice = (await pool.query(
    `INSERT INTO factures (entreprise_id, client_id, statut, date_facture, date_echeance, total_ttc, montant_paye, solde_restant)
     VALUES ($1, $2, 'payee', '2026-09-01', '2026-10-01', 100, 100, 0) RETURNING id`, [companyId, client.id],
  )).rows[0];
  await pool.query("INSERT INTO paiements (entreprise_id, facture_id, client_id, montant, date_paiement) VALUES ($1, $2, $3, 100, '2026-09-30')", [companyId, invoice.id, client.id]);
  const token = generateToken({ id: user.id, entrepriseId: companyId, role: 'admin' });
  // Public configuration only is written to disk. Credentials stay in memory.
  const config = path.join(directory, 'wrangler.json');
  await writeFile(config, JSON.stringify({
    name: 'lite-ai-local-check',
    main: path.resolve('generated-artifacts/cloudflare/cloudflare.js'),
    compatibility_date: '2026-10-16', compatibility_flags: ['nodejs_compat'],
  }));
  const bindings = Object.fromEntries(['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'GROQ_API_KEY'].map(k => [k, process.env[k]]).concat([
    ['NODE_ENV', 'production'], ['CLOUDFLARE_WORKER', 'true'],
  ]));
  if (nodeEgress) {
    // Explicit test-only transport bridge for sandboxes where workerd HTTPS
    // egress is blocked. Responses are from the real Groq API, not mocks.
    // No app code or production binding depends on this bridge.
    const local = new Miniflare(convertV4MiniflareOptions({
      name: 'lite-ai-local-check',
      modules: true, scriptPath: path.resolve('generated-artifacts/cloudflare/cloudflare.js'),
      compatibilityDate: '2026-10-16', compatibilityFlags: ['nodejs_compat'],
      bindings,
      outboundService: async request => {
        const url = new URL(request.url);
        if (url.origin !== 'https://api.groq.com') throw new Error('Test egress only permits Groq.');
        const requestHeaders = new Headers(request.headers);
        for (const name of ['host', 'content-length', 'transfer-encoding', 'connection', 'accept-encoding']) requestHeaders.delete(name);
        const response = await fetch(url, {
          method: request.method, headers: Object.fromEntries(requestHeaders),
          ...(request.method === 'POST' ? { body: Buffer.from(await request.arrayBuffer()) } : {}),
          signal: AbortSignal.timeout(45000),
        }).catch(error => {
          console.error('Test bridge transport failure:', error.name, error.cause?.code || 'no code');
          throw error;
        });
        const bytes = await response.arrayBuffer();
        if (!response.ok) {
          let code;
          try { code = JSON.parse(Buffer.from(bytes).toString()).error?.code; } catch { /* no response bodies in diagnostics */ }
          console.error('Test bridge provider failure:', url.pathname, response.status, code || 'no code');
        }
        const headers = new Headers(response.headers);
        // Node fetch already decodes the body; avoid decoding a second time.
        headers.delete('content-encoding'); headers.delete('content-length');
        return new WorkerResponse(bytes, { status: response.status, headers: Object.fromEntries(headers) });
      },
    }));
    worker = { fetch: (route, init) => local.dispatchFetch(`http://localhost${route}`, init), stop: () => local.dispose() };
    console.log('Test-only Node HTTPS bridge enabled; Groq responses are real. Native Cloudflare outbound networking is not validated by this mode.');
  } else worker = await unstable_dev(path.resolve('generated-artifacts/cloudflare/cloudflare.js'), {
    config, bundle: false, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0,
    logLevel: 'none', persist: false,
    experimental: { disableExperimentalWarning: true, watch: false, disableDevRegistry: true },
    vars: bindings,
  });
  const call = async (route, body, bearer = token) => {
    const response = await worker.fetch(`/api/ai${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(65000),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('/status')).body.data.configured, true);
  const analysis = await call(`/payment-analysis/${client.id}`, { explain: true });
  assert.equal(analysis.status, 200, 'Worker payment endpoint must succeed.');
  assert.equal(analysis.body.data.score, 100);
  assert.ok(analysis.body.data.explanation, `Real Groq explanation must succeed: ${analysis.body.data.explanationError || 'missing explanation'}`);
  assert.equal((await call(`/payment-analysis/${noHistory.id}`, { explain: false })).body.data.score, null);
  const foreignToken = generateToken({ id: user.id, entrepriseId: companyId + 1000000, role: 'admin' });
  assert.equal((await call(`/payment-analysis/${client.id}`, { explain: true }, foreignToken)).status, 404);
  console.log('✓ Local Worker: real PostgreSQL history, indicative score, real Groq explanation and tenant isolation.');
  assert.equal((await call('/prepare-photo', { image, consent: false })).status, 400);
  const prepared = await call('/prepare-photo', { image, consent: true });
  assert.equal(prepared.status, 200, 'Worker photo extraction must succeed.');
  assert.equal(prepared.body.data.draft.montant, 5000);
  assert.equal(prepared.body.data.draft.dateDepense, '2026-10-16');
  const before = await pool.query('SELECT count(*)::int AS n FROM depenses WHERE entreprise_id = $1', [companyId]);
  assert.equal(before.rows[0].n, 0);
  const confirmation = {
    draftToken: prepared.body.data.draftToken, confirmed: true,
    draft: { ...prepared.body.data.draft, description: 'Synthetic Worker transport QA', devise: 'FCFA' },
  };
  assert.equal((await call('/confirm', { ...confirmation, confirmed: false })).status, 400);
  assert.equal((await call('/confirm', confirmation, foreignToken)).status, 403);
  const confirmed = await call('/confirm', confirmation);
  assert.equal(confirmed.status, 200, 'Worker expense confirmation must succeed.');
  const replayed = await call('/confirm', confirmation);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.id, confirmed.body.id);
  const duplicate = await call('/prepare-photo', { image, consent: true });
  assert.equal(duplicate.body.data.duplicate, true);
  const after = await pool.query('SELECT count(*)::int AS n FROM depenses WHERE entreprise_id = $1', [companyId]);
  assert.equal(after.rows[0].n, 1);
  console.log('✓ Local Worker: real photo extraction, no pre-confirmation expense, confirmed write and replay without duplicates.');
} finally {
  await worker?.stop();
  if (companyId) {
    // Delete only this script's synthetic tenant; never touch existing tenants.
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      for (const table of ['approvals_depenses', 'audit_logs', 'depenses', 'categories_depenses', 'lite_idempotency', 'paiements', 'factures', 'clients', 'users', 'entreprises']) {
        await connection.query(`DELETE FROM ${table} WHERE ${table === 'entreprises' ? 'id' : 'entreprise_id'} = $1`, [companyId]);
      }
      await connection.query('COMMIT');
    } catch {
      await connection.query('ROLLBACK');
      throw new Error('Synthetic tenant cleanup failed; inspect AI Worker QA tenants before retrying.');
    } finally { connection.release(); }
  }
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
