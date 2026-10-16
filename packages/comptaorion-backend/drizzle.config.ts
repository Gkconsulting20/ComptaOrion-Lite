import { defineConfig } from 'drizzle-kit';
if (!process.env.DATABASE_URL) throw new Error('Configurer la nouvelle base Lite dans DATABASE_URL.');
export default defineConfig({
  out: './drizzle',
  schema: './src/schema.js',
  dialect: 'postgresql',
  strict: true,
  dbCredentials: { url: process.env.DATABASE_URL }
});
