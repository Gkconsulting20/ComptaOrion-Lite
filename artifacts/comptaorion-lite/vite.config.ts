import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

function liteServiceWorkerPlugin() {
  const workerSource = (assets: string[]) => `
const CACHE = 'comptaorion-lite-shell-${Date.now()}';
const SHELL = ${JSON.stringify(['/','/lite','/manifest.webmanifest','/logo-comptaorion.png',...assets])};
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
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use('/sw.js', (_request, response) => {
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/javascript');
        response.end(workerSource([
          '/src/main.tsx',
          '/src/App.tsx',
          '/src/LiteApp.jsx',
          '/src/pages/Login.jsx',
          '/src/lite.css',
          '/src/liteDb.js',
          '/src/api.js',
        ]));
      });
    },
    generateBundle(_options: unknown, bundle: Record<string, { type: string }>) {
      const assets = Object.keys(bundle).filter((fileName) =>
        fileName.includes('LiteApp-') || fileName.includes('Login-') ||
        fileName.endsWith('.css') || fileName.split('/').pop()?.startsWith('index-')
      ).map(fileName => `/${fileName}`);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: workerSource(assets) });
    },
  };
}

const rawPort = process.env.PORT;

if (!rawPort) {
  throw new Error(
    'PORT environment variable is required but was not provided.',
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH;

if (!basePath) {
  throw new Error(
    'BASE_PATH environment variable is required but was not provided.',
  );
}

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    liteServiceWorkerPlugin(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
