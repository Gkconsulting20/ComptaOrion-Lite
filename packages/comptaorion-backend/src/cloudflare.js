import { httpServerHandler } from 'cloudflare:node';
import { configurationProblems } from './cloudflare-config.js';
import { createDatabaseContext, runWithDatabaseContext } from './db.js';

let serverReady;

function getServer() {
  if (!serverReady) {
    serverReady = import('./app.js').then(({ default: app }) => {
      app.listen(3000);
      return httpServerHandler({ port: 3000 });
    }).catch((error) => {
      serverReady = undefined;
      console.error('Initialisation du serveur Workers impossible:', error.name, error.message);
      throw error;
    });
  }
  return serverReady;
}

export default {
  async fetch(request, env, executionContext) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/api' && !pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const problems = configurationProblems(env);
    if (problems.length) {
      return Response.json({
        status: 'configuration_required',
        application: 'ComptaOrion Lite',
        problems,
      }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    let database;
    try {
      const server = await getServer();
      database = createDatabaseContext(env.DATABASE_URL, { worker: true });
      return await runWithDatabaseContext(database, () =>
        server.fetch(request, env, executionContext));
    } catch {
      console.error('ComptaOrion Lite : échec de la requête API sur Workers.');
      return Response.json({ success: false, message: 'Service temporairement indisponible' }, { status: 503 });
    } finally {
      if (database) {
        // The response body may still be streaming; finish outstanding queries
        // without keeping connections alive across Worker requests.
        executionContext.waitUntil(database.pool.end().catch(() => {
          console.error('ComptaOrion Lite : fermeture du pool PostgreSQL impossible.');
        }));
      }
    }
  },
};
