import { Pool as NeonPool, neonConfig } from '@neondatabase/serverless';
import { drizzle as drizzleNeon } from 'drizzle-orm/neon-serverless';
import pg from 'pg';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import ws from 'ws';
import * as schema from './schema.js';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL must be set. Did you forget to provision a database?',
  );
}

const isNeon = process.env.DATABASE_URL.includes('neon.tech');
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
  
  const connectionString = getPooledConnectionString(process.env.DATABASE_URL);
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
  console.log('✅ Base de données Neon connectée');
} else {
  pool = new pg.Pool({ 
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: isProduction ? { rejectUnauthorized: false } : false
  });
  db = drizzlePg({ client: pool, schema });
  console.log('✅ Base de données PostgreSQL connectée');
}

export { pool, db };
