// Local-only smoke checks: no login to Cloudflare, deployment or real database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHmac } from 'node:crypto';

const directory = await mkdtemp(path.join(tmpdir(), 'lite-worker-smoke-'));
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
let nextPort = 8799;
const config = {
  name: 'comptaorion-lite-local-smoke',
  main: path.resolve('generated-artifacts/cloudflare/cloudflare.js'),
  compatibility_date: '2026-10-16',
  compatibility_flags: ['nodejs_compat'],
  assets: {
    directory: path.resolve('artifacts/comptaorion-lite/dist/public'),
    binding: 'ASSETS',
    not_found_handling: 'single-page-application',
    run_worker_first: ['/api', '/api/*'],
  },
  vars: { NODE_ENV: 'production', CLOUDFLARE_WORKER: 'true' },
};

async function run(vars, verify) {
  const port = nextPort++;
  const origin = `http://127.0.0.1:${port}`;
  const configPath = path.join(directory, 'wrangler.json');
  await writeFile(configPath, JSON.stringify({ ...config, vars: { ...config.vars, ...vars } }));
  const child = spawn(command, ['exec', 'wrangler', 'dev', '--local', '--no-bundle',
    '--config', configPath, '--port', String(port), '--inspector-port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data.toString(); });
  child.stderr.on('data', data => { logs += data.toString(); });
  let exited = false;
  const ended = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150 && !exited; attempt++) {
      try {
        const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch { /* Wait for the local Worker to start. */ }
      await delay(200);
    }
    assert.ok(ready, `Local Worker did not become ready.\n${logs.slice(-6000)}`);
    await verify(origin);
  } catch (error) {
    await delay(100);
    console.error(logs.slice(-6000));
    throw error;
  } finally {
    if (!exited) {
      if (process.platform === 'win32') child.kill();
      else process.kill(-child.pid, 'SIGTERM');
    }
    await Promise.race([ended, delay(3000)]);
    if (process.platform !== 'win32') {
      // pnpm can exit before its Wrangler/workerd children.
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
}

try {
  await run({}, async (origin) => {
    const response = await fetch(`${origin}/api/healthz`);
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.status, 'configuration_required');
    assert.equal(result.problems.length, 3);
    console.log('✓ Missing secrets fail closed; the frontend remains accessible.');
  });
  // Public test fixtures only, never used for an actual deployed application.
  await run({
    DATABASE_URL: 'postgresql://test:fixture@database.invalid/lite',
    JWT_SECRET: 'test-access-fixture-not-a-real-secret',
    JWT_REFRESH_SECRET: 'test-refresh-fixture-not-a-real-secret',
  }, async (origin) => {
    const page = await fetch(`${origin}/lite`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="root"/);
    const health = await fetch(`${origin}/api/healthz`);
    const result = await health.json();
    assert.equal(health.status, 200, JSON.stringify(result));
    assert.equal(result.application, 'ComptaOrion Lite');
    assert.equal((await fetch(`${origin}/api/produits`)).status, 401);
    assert.equal((await fetch(`${origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })).status, 400);
    // Reach the DB proxy through the native Workers -> Express bridge.
    // The invalid test hostname must fail, but never because the request
    // lost its isolated database context. No real account or DB is involved.
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
      id: 1, entrepriseId: 1, role: 'admin', exp: Math.floor(Date.now() / 1000) + 60,
    })}`;
    const signature = createHmac('sha256', 'test-access-fixture-not-a-real-secret')
      .update(unsigned).digest('base64url');
    const dbProbe = await fetch(`${origin}/api/produits`, {
      headers: { Authorization: `Bearer ${unsigned}.${signature}` },
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(dbProbe.status, 500);
    const dbFailure = await dbProbe.json();
    assert.doesNotMatch(JSON.stringify(dbFailure), /request scope|different request|cross.context/i);
    assert.ok(dbFailure.error, 'The test database must fail with a transport error.');
    console.log('✓ Workers serves the SPA, Express health, protected API and registration validation.');
    console.log('✓ Authenticated requests preserve their PostgreSQL context across the Workers/Express bridge.');
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
