import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import pg from 'pg';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import ws from 'ws';
import * as schema from './schema.js';
import { AsyncLocalStorage } from 'node:async_hooks';

// Workers cannot reuse a TCP connection from a previous request. Node keeps
// its normal application pool; the Worker supplies a separate request scope.
const databaseScope = new AsyncLocalStorage();
let nodeDatabase;

export function createDatabaseContext(connectionString, { worker = false } = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL must be set for the independent Lite database.');
  }
  const isNeon = connectionString.includes('neon.tech') && !worker;
  const isProduction = process.env.NODE_ENV === 'production';
  let pool;
  let db;

  if (isNeon) {
  neonConfig.webSocketConstructor = ws;
  neonConfig.pipelineConnect = false;
  neonConfig.useSecureWebSocket = true;
  
  function getPooledConnectionString(url) {
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.includes('-pooler')) {
        parsed.hostname = parsed.hostname.replace(/^([^.]+)(.*)/, '$1-pooler$2');
      }
      return parsed.toString();
    } catch (e) {
      return url;
    }
  }
  
  connectionString = getPooledConnectionString(connectionString);
  pool = new NeonPool({ 
    connectionString,
    max: 5,
    min: 1,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
    allowExitOnIdle: false
  });
  
  pool.on('error', (err) => {
    console.error('Erreur pool Neon:', err.message);
  });
  
  db = drizzleNeon({ client: pool, schema });
  } else {
  pool = new pg.Pool({ 
    connectionString,
    max: worker ? 3 : 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: worker ? { rejectUnauthorized: true } : (isProduction ? { rejectUnauthorized: false } : false)
  });
  db = drizzlePg({ client: pool, schema });
  }
  return { pool, db };
}

export function initializeDatabase() {
  nodeDatabase ??= createDatabaseContext(process.env.DATABASE_URL);
  return nodeDatabase;
}

export function runWithDatabaseContext(context, operation) {
  return databaseScope.run(context, operation);
}

function currentDatabase() {
  const requestDatabase = databaseScope.getStore();
  if (requestDatabase) return requestDatabase;
  if (process.env.CLOUDFLARE_WORKER === 'true') {
    throw new Error('Database access requires a Worker request scope.');
  }
  return initializeDatabase();
}

function scopedProxy(name) {
  return new Proxy({}, {
    get(_target, property) {
      const target = currentDatabase()[name];
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const pool = scopedProxy('pool');
export const db = scopedProxy('db');
