// Vérification e-mail par code à 6 chiffres (28 nov. 2026, design validé
// par Cap le 27 nov.) : règles pures (sans base) + parcours base de données
// dans un schéma jetable (jamais la base live).
// Règles : code 6 chiffres hashé SHA-256, validité 15 min, 5 tentatives max
// puis code invalidé, 3 codes invalidés d'affilée → blocage 1 h, renvoi
// après 60 s min, 3 renvois max / heure / e-mail, essai 30 jours démarrant
// à la vérification (saas_clients.date_inscription réinitialisée).
import test from 'node:test';
import assert from 'node:assert/strict';

// db.js exige DATABASE_URL à l'import : valeur factice, les
// tests purs (aucune connexion n'est ouverte sans requête).
process.env.DATABASE_URL ??= 'postgresql://test:fixture@database.invalid/lite';

const {
  CODE_TTL_MS,
  CODE_MAX_ATTEMPTS,
  CODE_MAX_INVALIDATED_IN_A_ROW,
  CODE_BLOCK_MS,
  RESEND_MIN_INTERVAL_MS,
  RESEND_MAX_PER_HOUR,
  UNVERIFIED_PURGE_DAYS,
  generateVerificationCode,
  hashVerificationCode,
  matchesCodeHash,
  isCodeExpired,
  computeBlockedUntil,
  checkResendAllowed,
  isEmailVerificationRequired,
} = await import('../src/services/emailVerification.js');
const { isEligibleForUnverifiedPurge } = await import('../src/services/trialLifecycle.js');

test('constantes du design validé par Cap', () => {
  assert.equal(CODE_TTL_MS, 15 * 60 * 1000);
  assert.equal(CODE_MAX_ATTEMPTS, 5);
  assert.equal(CODE_MAX_INVALIDATED_IN_A_ROW, 3);
  assert.equal(CODE_BLOCK_MS, 60 * 60 * 1000);
  assert.equal(RESEND_MIN_INTERVAL_MS, 60 * 1000);
  assert.equal(RESEND_MAX_PER_HOUR, 3);
  assert.equal(UNVERIFIED_PURGE_DAYS, 7);
});

test('code à 6 chiffres, hash SHA-256, comparaison à temps constant', () => {
  for (let i = 0; i < 20; i += 1) {
    const code = generateVerificationCode();
    assert.match(code, /^\d{6}$/);
    assert.equal(hashVerificationCode(code).length, 64);
    assert.equal(matchesCodeHash(code, hashVerificationCode(code)), true);
  }
  assert.equal(matchesCodeHash('123456', hashVerificationCode('123457')), false);
  assert.equal(matchesCodeHash('12345', hashVerificationCode('123456')), false);
  assert.equal(matchesCodeHash('123456', ''), false);
});

test('expiration : 15 minutes, à la seconde près', () => {
  const createdAt = new Date('2026-11-28T10:00:00.000Z');
  const row = { expiresAt: new Date(createdAt.getTime() + CODE_TTL_MS) };
  assert.equal(isCodeExpired(row, new Date('2026-11-28T10:14:59.999Z')), false);
  assert.equal(isCodeExpired(row, new Date('2026-11-28T10:15:00.000Z')), true);
  assert.equal(isCodeExpired(row, new Date('2026-11-28T10:16:00.000Z')), true);
});

test('blocage : 3 codes invalidés d’affilée → 1 heure, puis libre', () => {
  const now = new Date('2026-11-28T10:00:00.000Z');
  const invalidated = (minutesAgo) => ({
    statut: 'invalide',
    invalidatedAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
    createdAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
  });
  // 2 codes invalidés : pas de blocage.
  assert.equal(computeBlockedUntil([invalidated(10), invalidated(20)], now), null);
  // 3 codes invalidés d'affilée, le 3e il y a 10 min → bloqué jusqu'à +50 min.
  const blockedUntil = computeBlockedUntil(
    [invalidated(5), invalidated(10), invalidated(20)], now,
  );
  assert.ok(blockedUntil instanceof Date);
  assert.equal(blockedUntil.toISOString(), '2026-11-28T10:40:00.000Z');
  // Même série mais le 3e invalidé il y a plus d'1 h : blocage expiré.
  assert.equal(computeBlockedUntil(
    [invalidated(5), invalidated(10), invalidated(70)], now,
  ), null);
  // Un code utilisé interrompt la série : pas de blocage.
  assert.equal(computeBlockedUntil(
    [invalidated(5), invalidated(10), { statut: 'utilise', createdAt: now }],
    now,
  ), null);
  // Un code actif (plus récent) interrompt aussi la série.
  assert.equal(computeBlockedUntil(
    [{ statut: 'actif', createdAt: now }, invalidated(5), invalidated(10), invalidated(20)],
    now,
  ), null);
  // Un code remplacé interrompt la série (le renvoi n'est pas un échec).
  assert.equal(computeBlockedUntil(
    [invalidated(5), { statut: 'remplace', createdAt: now }, invalidated(10), invalidated(20)],
    now,
  ), null);
});

test('renvoi : 60 s minimum, 3 renvois max par heure', () => {
  const now = new Date('2026-11-28T10:00:00.000Z');
  assert.deepEqual(
    checkResendAllowed({ lastCreatedAt: new Date(now.getTime() - 30 * 1000), createdLastHour: 0, now }),
    { allowed: false, reason: 'trop-tot', retryAfterSeconds: 30 },
  );
  assert.deepEqual(
    checkResendAllowed({ lastCreatedAt: new Date(now.getTime() - 61 * 1000), createdLastHour: 0, now }),
    { allowed: true, reason: 'ok', retryAfterSeconds: 0 },
  );
  assert.deepEqual(
    checkResendAllowed({ lastCreatedAt: new Date(now.getTime() - 10 * 60 * 1000), createdLastHour: 3, now }),
    { allowed: false, reason: 'limite-horaire', retryAfterSeconds: 3600 },
  );
  assert.deepEqual(
    checkResendAllowed({ lastCreatedAt: new Date(now.getTime() - 10 * 60 * 1000), createdLastHour: 2, now }),
    { allowed: true, reason: 'ok', retryAfterSeconds: 0 },
  );
  assert.deepEqual(
    checkResendAllowed({ lastCreatedAt: null, createdLastHour: 0, now }),
    { allowed: true, reason: 'ok', retryAfterSeconds: 0 },
  );
});

test('qui est bloqué par la vérification : jamais ORIONEXA ni les démos', () => {
  // Compte déjà vérifié : jamais bloqué.
  assert.equal(isEmailVerificationRequired({ entrepriseId: 42, emailVerifiedAt: new Date() }), false);
  // Entreprise 1 (ORIONEXA / Cap) : jamais bloquée, même non vérifiée.
  assert.equal(isEmailVerificationRequired({ entrepriseId: 1, emailVerifiedAt: null }), false);
  // Démo : exclue par construction.
  assert.equal(
    isEmailVerificationRequired({ entrepriseId: 42, emailVerifiedAt: null }, { isDemoEntreprise: true }),
    false,
  );
  // Nouveau compte ordinaire non vérifié : bloqué.
  assert.equal(isEmailVerificationRequired({ entrepriseId: 42, emailVerifiedAt: null }), true);
});

test('purge des comptes jamais vérifiés : éligibilité', () => {
  const base = {
    id: 42, isDemo: false, hasVerifiedUser: false,
    hasConfirmedSale: false, hasPaidSubscription: false,
    dateInscription: new Date('2026-11-20T10:00:00.000Z'),
  };
  const now = new Date('2026-11-28T10:00:00.000Z');
  assert.deepEqual(
    isEligibleForUnverifiedPurge(base, { now }).eligible, true,
  );
  // Moins de 7 jours : pas encore.
  assert.equal(
    isEligibleForUnverifiedPurge({ ...base, dateInscription: new Date('2026-11-25T10:00:00.000Z') }, { now }).eligible,
    false,
  );
  // Un seul utilisateur vérifié suffit à protéger l'entreprise.
  assert.equal(
    isEligibleForUnverifiedPurge({ ...base, hasVerifiedUser: true }, { now }).eligible, false,
  );
  // Vente confirmée ou abonnement payant : protégée.
  assert.equal(
    isEligibleForUnverifiedPurge({ ...base, hasConfirmedSale: true }, { now }).eligible, false,
  );
  assert.equal(
    isEligibleForUnverifiedPurge({ ...base, hasPaidSubscription: true }, { now }).eligible, false,
  );
  // Entreprise 1 et démos : jamais.
  assert.equal(isEligibleForUnverifiedPurge({ ...base, id: 1 }, { now }).eligible, false);
  assert.equal(isEligibleForUnverifiedPurge({ ...base, isDemo: true }, { now }).eligible, false);
});

// ---------------------------------------------------------------------------
// Parcours base de données (schéma jetable) — gardé par
// EMAIL_VERIFICATION_DB_TEST=1 + DATABASE_URL. Ne touche jamais aux
// données existantes.
// ---------------------------------------------------------------------------
const DB_ENABLED = process.env.EMAIL_VERIFICATION_DB_TEST === '1' && Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL.includes('database.invalid');

test('parcours base : création, tentatives, expiration, vérification, essai', {
  skip: !DB_ENABLED,
  timeout: 300000,
}, async () => {
  const { execFileSync } = await import('node:child_process');
  const { randomUUID } = await import('node:crypto');
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const databaseSchema = await import('../src/schema.js');
  const service = await import('../src/services/emailVerification.js');

  const schema = `ev_test_${randomUUID().replaceAll('-', '')}`;
  // Neon : le pooler refuse le paramètre de démarrage `options`
  // (search_path) — on utilise l'hôte non-pooler pour ce test.
  const directConnectionString = process.env.DATABASE_URL.replace('-pooler', '');
  const admin = new pg.Pool({ connectionString: directConnectionString });
  let testPool;
  try {
    const ddl = execFileSync(process.execPath, [
      'node_modules/drizzle-kit/bin.cjs', 'export',
      '--dialect=postgresql', '--schema=./src/schema.js',
    ], { encoding: 'utf8' }).replaceAll('"public".', `"${schema}".`);
    const client = await admin.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(ddl);
    } finally { client.release(); }

    const schemaUrl = new URL(directConnectionString);
    schemaUrl.searchParams.set('options', `-c search_path=${schema}`);
    testPool = new pg.Pool({ connectionString: schemaUrl.toString() });
    const testDb = drizzle({ client: testPool, schema: databaseSchema });

    const [entreprise] = await testDb.insert(databaseSchema.entreprises).values({
      nom: 'Entreprise code de test', email: 'code-test@example.invalid', pays: 'Togo',
    }).returning();
    const [user] = await testDb.insert(databaseSchema.users).values({
      nom: 'Testeur', email: 'code-test@example.invalid', username: `testeur_${randomUUID().slice(0, 8)}`,
      passwordHash: 'hash-factice', entrepriseId: entreprise.id, role: 'admin', actif: true,
    }).returning();
    const inscritLe = new Date('2026-11-28T09:00:00.000Z');
    await testDb.insert(databaseSchema.saasClients).values({
      entrepriseId: entreprise.id, statut: 'trial', source: 'web',
      dateInscription: inscritLe,
    });

    // 1. Création : un seul code actif, hashé (jamais le code en clair).
    const created = await service.createVerificationCode(testDb, {
      userId: user.id, email: user.email, now: new Date('2026-11-28T10:00:00.000Z'),
    });
    assert.match(created.code, /^\d{6}$/);
    assert.notEqual(created.record.codeHash, created.code);
    assert.equal(created.record.statut, 'actif');
    assert.equal(created.record.tentatives, 0);

    // 2. Code erroné : refus, compteur de tentatives, 5e tentative invalide.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const wrong = await service.verifyEmailCode(testDb, { user, code: '000000', now: new Date('2026-11-28T10:05:00.000Z') });
      assert.equal(wrong.ok, false);
      assert.equal(wrong.reason, 'code-invalide');
      assert.equal(wrong.attemptsLeft, 5 - attempt);
    }
    const fifth = await service.verifyEmailCode(testDb, { user, code: '000000', now: new Date('2026-11-28T10:05:00.000Z') });
    assert.equal(fifth.ok, false);
    assert.equal(fifth.reason, 'tentatives-epuisees');
    assert.equal(fifth.attemptsLeft, 0);
    const afterExhaustion = await service.getActiveCode(testDb, user.id);
    assert.equal(afterExhaustion, null);

    // 3. Nouveau code puis expiration (15 min) : refus + statut expire.
    const second = await service.createVerificationCode(testDb, {
      userId: user.id, email: user.email, now: new Date('2026-11-28T10:10:00.000Z'),
    });
    const expired = await service.verifyEmailCode(testDb, {
      user, code: second.code, now: new Date('2026-11-28T10:26:00.000Z'),
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, 'expire');

    // 4. Code correct : vérification + essai redémarré à cet instant.
    const third = await service.createVerificationCode(testDb, {
      userId: user.id, email: user.email, now: new Date('2026-11-28T10:30:00.000Z'),
    });
    const verifiedAt = new Date('2026-11-28T10:32:00.000Z');
    const good = await service.verifyEmailCode(testDb, { user, code: third.code, now: verifiedAt });
    assert.equal(good.ok, true);
    const { trialExpiresAt } = await service.markEmailVerifiedAndStartTrial(testDb, { user, now: verifiedAt });
    assert.equal(trialExpiresAt.toISOString(), '2026-12-28T10:32:00.000Z');
    const { eq } = await import('drizzle-orm');
    const [refreshedUser] = await testDb.select({ emailVerifiedAt: databaseSchema.users.emailVerifiedAt })
      .from(databaseSchema.users).where(eq(databaseSchema.users.id, user.id));
    assert.equal(new Date(refreshedUser.emailVerifiedAt).toISOString(), verifiedAt.toISOString());
    // L'essai Lite vit dans saas_clients.date_inscription : réinitialisée
    // sur la vérification (l'essai démarre à cet instant).
    const [saasClient] = await testDb.select()
      .from(databaseSchema.saasClients)
      .where(eq(databaseSchema.saasClients.entrepriseId, entreprise.id));
    assert.equal(new Date(saasClient.dateInscription).toISOString(), verifiedAt.toISOString());
  } finally {
    if (testPool) await testPool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
