import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'SOS DZ',
        short_name: 'SOS DZ',
        description: 'Disaster relief coordination for Algeria',
        theme_color: '#111111',
        background_color: '#fafafa',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Without this, the SW's default SPA navigateFallback ('index.html')
        // catches EVERY full-page navigation not otherwise matched -- Django
        // Admin isn't part of the React Router SPA, so a request for
        // /admin/ was being served the cached React app shell instead of
        // ever reaching the real Django page. Same for /static/ (Django's
        // own static files) and /media/ (also excluded below via
        // runtimeCaching, but a non-GET navigation there should still skip
        // the SPA fallback too).
        navigateFallbackDenylist: [/^\/admin\//, /^\/static\//, /^\/media\//],
        // Cache already-loaded data/app-shell for offline browsing; API
        // writes (POST/PATCH/DELETE) are handled separately by our own
        // IndexedDB queue (src/offlineQueue.js), not by the service worker.
        runtimeCaching: [
          {
            urlPattern: ({ url, request }) => url.pathname.startsWith('/api/') && request.method === 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-get-cache',
              networkTimeoutSeconds: 4,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/media/'),
            handler: 'CacheFirst',
            options: { cacheName: 'media-cache', expiration: { maxEntries: 200 } },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/media': 'http://127.0.0.1:8000',
      // Not part of the deployed app's own routing (the built SPA never
      // links here except the admin-mode logout link) -- proxied purely so
      // that link works from the Vite dev server too, same as /api.
      '/admin': 'http://127.0.0.1:8000',
      '/static': 'http://127.0.0.1:8000',
    },
  },
  preview: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/media': 'http://127.0.0.1:8000',
      '/admin': 'http://127.0.0.1:8000',
      '/static': 'http://127.0.0.1:8000',
    },
  },
})
