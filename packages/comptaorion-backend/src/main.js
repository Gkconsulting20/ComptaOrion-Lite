import 'dotenv/config';
import app from './app.js';
import { initializeTenantSetting } from './utils/rlsPolicies.js';

await initializeTenantSetting();
const port = process.env.PORT || (process.env.NODE_ENV === 'production' ? 5000 : 3000);
app.listen(port, '0.0.0.0', () => console.log(`ComptaOrion Lite démarré sur le port ${port}`));
