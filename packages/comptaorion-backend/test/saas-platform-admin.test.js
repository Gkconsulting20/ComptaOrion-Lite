import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { runWithDatabaseContext } from '../src/db.js';

process.env.JWT_SECRET ||= 'unit-test-platform-owner-access-secret';
process.env.JWT_REFRESH_SECRET ||= 'unit-test-platform-owner-refresh-secret';
process.env.SAAS_PLATFORM_OWNER_EMAIL = 'admin@orionexa.net';

const [{ authMiddleware }, { requirePlatformOwner }] = await Promise.all([
  import('../src/auth.js'),
  import('../src/routes/saas-platform-admin.js'),
]);
const { default: fullApp } = await import('../src/app.js');

function appWithAccount(account) {
  const app = express();
  const fakeDb = {
    select() {
      const query = {
        from() { return query; },
        where() { return query; },
        limit() { return Promise.resolve(account ? [account] : []); },
      };
      return query;
    },
  };
  app.use((req, res, next) => runWithDatabaseContext({ db: fakeDb, pool: {} }, next));
  app.use(authMiddleware);
  app.use(requirePlatformOwner);
  app.get('/protected', (_req, res) => res.json({ ok: true }));
  return app;
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function tokenFor(email = 'admin@orionexa.net') {
  return jwt.sign({ id: 9, email, role: 'admin', entrepriseId: 2 }, process.env.JWT_SECRET);
}

test('l’espace plateforme rejette une requête sans authentification', async () => {
  await withServer(appWithAccount(null), async (base) => {
    const response = await fetch(`${base}/protected`);
    assert.equal(response.status, 401);
  });
});

test('un administrateur de commerçant ne devient pas administrateur de la plateforme', async () => {
  await withServer(appWithAccount({ email: 'marchand@example.test', role: 'admin', actif: true }), async (base) => {
    const response = await fetch(`${base}/protected`, {
      headers: { Authorization: `Bearer ${tokenFor('marchand@example.test')}` },
    });
    assert.equal(response.status, 403);
  });
});

test('le compte propriétaire doit être actif et avoir le rôle admin', async () => {
  for (const account of [
    { email: 'admin@orionexa.net', role: 'manager', actif: true },
    { email: 'admin@orionexa.net', role: 'admin', actif: false },
  ]) {
    await withServer(appWithAccount(account), async (base) => {
      const response = await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${tokenFor()}` } });
      assert.equal(response.status, 403);
    });
  }
});

test('seul le compte propriétaire actif franchit la protection plateforme', async () => {
  await withServer(appWithAccount({ email: 'Admin@Orionexa.net', role: 'admin', actif: true }), async (base) => {
    const response = await fetch(`${base}/protected`, { headers: { Authorization: `Bearer ${tokenFor()}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test('les routes réellement montées de gestion SaaS rejettent les visiteurs non connectés', async () => {
  await withServer(fullApp, async (base) => {
    const response = await fetch(`${base}/api/saas-admin/dashboard`);
    assert.equal(response.status, 401);
  });
});
