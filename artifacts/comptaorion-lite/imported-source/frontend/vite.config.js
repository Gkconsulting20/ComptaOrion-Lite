import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function liteServiceWorkerPlugin() {
  const workerSource = (assets) => `
const CACHE = 'orion-lite-shell-${Date.now()}';
const SHELL = ${JSON.stringify(['/', '/lite', '/manifest.webmanifest', '/logo-comptaorion.png', ...assets])};
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.pathname.startsWith('/api')) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (!response.ok) return response;
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy));
    return response;
  }).catch(() => cached)));
});
`;

  return {
    name: 'comptaorion-lite-service-worker',
    configureServer(server) {
      server.middlewares.use('/sw.js', (_request, response) => {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/javascript');
        response.end(workerSource([
          '/src/main.jsx',
          '/src/LiteApp.jsx',
          '/src/lite.css',
          '/src/liteDb.js',
          '/src/api.js',
          '/src/pages/Login.jsx',
        ]));
      });
    },
    generateBundle(_options, bundle) {
      const liteAssets = Object.keys(bundle).filter((fileName) => {
        if (fileName.includes('LiteApp-') || fileName.includes('Login-')) return true;
        if (fileName.endsWith('.css')) return true;
        return fileName.split('/').pop().startsWith('index-');
      }).map(fileName => `/${fileName}`);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: workerSource(liteAssets),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), liteServiceWorkerPlugin()],
  resolve: {
    alias: {
      '@assets': path.resolve(__dirname, '../attached_assets')
    }
  },
  server: {
    host: '0.0.0.0',
    port: 5000,
    allowedHosts: true,
    historyApiFallback: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  },
  appType: 'spa'
});
