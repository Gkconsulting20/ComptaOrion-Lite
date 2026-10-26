import { defineConfig } from 'drizzle-kit';
if (!process.env.DATABASE_URL) throw new Error('Configurer la nouvelle base Lite dans DATABASE_URL.');
export default defineConfig({
  out: './drizzle',
  schema: './src/schema.js',
  dialect: 'postgresql',
  // Keep additive schema setup non-interactive; Drizzle still prompts before
  // destructive changes when --force is not supplied.
  strict: false,
  dbCredentials: { url: process.env.DATABASE_URL }
});
