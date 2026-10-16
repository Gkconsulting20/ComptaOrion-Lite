import { pool } from '../db.js';

let tableReady;

async function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS lite_idempotency (
        entreprise_id INTEGER NOT NULL,
        idempotency_key VARCHAR(128) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'processing',
        response_status INTEGER,
        response_body JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (entreprise_id, idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS lite_idempotency_key_unique
        ON lite_idempotency (idempotency_key)
    `);
  }
  await tableReady;
}

export class IdempotencyConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdempotencyConflictError';
    this.status = 409;
  }
}

export async function claimIdempotentOperation({
  entrepriseId,
  idempotencyKey,
  insertClaim,
  findByKey,
}) {
  if (!idempotencyKey) return { claimed: false };

  const claim = await insertClaim();
  if (claim) return { claimed: true };

  const existing = await findByKey();
  if (existing && Number(existing.entrepriseId) !== Number(entrepriseId)) {
    throw new IdempotencyConflictError(
      'Cette opération appartient à une autre entreprise',
    );
  }
  if (existing?.status === 'completed') {
    return {
      claimed: false,
      replay: true,
      status: existing.responseStatus,
      body: existing.responseBody,
    };
  }
  throw new IdempotencyConflictError('Cette opération est déjà en cours');
}

export async function idempotencyMiddleware(req, res, next) {
  const rawKey = req.get('X-Idempotency-Key');
  if (!rawKey) return next();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(rawKey)) {
    return res.status(400).json({ success: false, message: 'Clé d’idempotence invalide' });
  }
  req.idempotencyKey = rawKey;
  if ((req.method === 'POST' && req.path === '/factures/lite-sale') ||
      (req.method === 'POST' && req.path === '/depenses/create')) {
    try {
      await ensureTable();
      return next();
    } catch (error) {
      return next(error);
    }
  }

  try {
    await ensureTable();
    const claim = await pool.query(
      `INSERT INTO lite_idempotency (entreprise_id, idempotency_key)
       VALUES ($1, $2)
       ON CONFLICT (entreprise_id, idempotency_key) DO NOTHING
       RETURNING status`,
      [req.entrepriseId, rawKey]
    );
    if (claim.rowCount === 0) {
      const existing = await pool.query(
        `SELECT entreprise_id, status, response_status, response_body
         FROM lite_idempotency WHERE idempotency_key = $1`,
        [rawKey]
      );
      const row = existing.rows[0];
      if (row && Number(row.entreprise_id) !== Number(req.entrepriseId)) {
        return res.status(409).json({
          success: false,
          message: 'Cette opération appartient à une autre entreprise',
        });
      }
      if (row?.status === 'completed') {
        return res.status(row.response_status || 200).json(row.response_body);
      }
      return res.status(409).json({ success: false, message: 'Cette opération est déjà en cours' });
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const status = res.statusCode;
      if (status >= 200 && status < 400) {
        pool.query(
          `UPDATE lite_idempotency SET status = 'completed', response_status = $3,
           response_body = $4::jsonb, updated_at = NOW()
           WHERE entreprise_id = $1 AND idempotency_key = $2`,
          [req.entrepriseId, rawKey, status, JSON.stringify(body)]
        ).catch(() => {});
      } else {
        pool.query(
          `DELETE FROM lite_idempotency WHERE entreprise_id = $1 AND idempotency_key = $2`,
          [req.entrepriseId, rawKey]
        ).catch(() => {});
      }
      return originalJson(body);
    };
    return next();
  } catch (error) {
    return next(error);
  }
}