import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import app from './app.js';
import { initializeTenantSetting } from './utils/rlsPolicies.js';
import { initializeDatabase } from './db.js';

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url));
dotenv.config({ path: path.join(workspaceRoot, '.env.local'), override: true });
dotenv.config({ path: path.join(workspaceRoot, '.env') });

initializeDatabase();
await initializeTenantSetting();
const port = process.env.PORT || (process.env.NODE_ENV === 'production' ? 5000 : 3000);
app.listen(port, '0.0.0.0', () => console.log(`ComptaOrion Lite démarré sur le port ${port}`));
