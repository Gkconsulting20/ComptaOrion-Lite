import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authRoutes from './routes/auth.js';
import authSecurityRoutes from './routes/auth-security.js';
import clientsRoutes from './routes/clients.js';
import produitsRoutes from './routes/produits.js';
import facturesRoutes from './routes/factures.js';
import depensesRoutes from './routes/dépenses.js';
import financialReportsRoutes from './routes/financial-reports.js';
import aiRoutes from './routes/ai.js';
import litePurchasesRoutes from './routes/lite-purchases.js';
import { authMiddleware, entrepriseIsolation } from './auth.js';
import { createTenantMiddleware } from './utils/rlsPolicies.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';

const app = express();
// Larger body only for transient photo inference, not for all API endpoints.
app.use('/api/ai/prepare-photo', express.json({ limit: '6mb' }));
app.use(express.json({ limit: '100kb' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok', application: 'ComptaOrion Lite' }));
app.get('/api/healthz', (_req, res) => res.json({ status: 'ok', application: 'ComptaOrion Lite' }));
app.use('/api/auth', authRoutes);
app.use('/api/auth-security', authSecurityRoutes);
app.use('/api', authMiddleware, entrepriseIsolation, createTenantMiddleware(), idempotencyMiddleware);
app.use('/api/clients', clientsRoutes);
app.use('/api/produits', produitsRoutes);
app.use('/api/factures', facturesRoutes);
app.use('/api/depenses', depensesRoutes);
app.use('/api/financial-reports', financialReportsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api', litePurchasesRoutes);
app.use((error, _req, res, next) => {
  if (error.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'Photo trop volumineuse (4 Mio maximum).' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ success: false, message: 'Corps JSON invalide.' });
  return next(error);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Route non disponible dans Lite' }));
// Cloudflare serves the frontend through its ASSETS binding, not a filesystem.
if (process.env.CLOUDFLARE_WORKER !== 'true') {
  const dist = fileURLToPath(new URL('../../../artifacts/comptaorion-lite/dist/public/', import.meta.url));
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
export default app;
