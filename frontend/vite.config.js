import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'favicon-16x16.png', 'favicon-32x32.png', 'apple-touch-icon.png', 'logo.png'],
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
        // Lets a newly-installed service worker activate and take control
        // of already-open tabs on its very next background update check,
        // instead of only after every open tab is closed and reopened --
        // so future deploys need one page load to take effect, not two.
        skipWaiting: true,
        clientsClaim: true,
        // Without this, the SW's default SPA navigateFallback ('index.html')
        // catches EVERY full-page navigation not otherwise matched -- Django
        // Admin isn't part of the React Router SPA, so a request for
        // /admin/ was being served the cached React app shell instead of
        // ever reaching the real Django page. Same for /static/ (Django's
        // own static files) and /media/ (also excluded below via
        // runtimeCaching, but a non-GET navigation there should still skip
        // the SPA fallback too). Matches both the bare path ("/admin") and
        // anything under it ("/admin/...") -- a trailing-slash-only regex
        // let "/admin" (no slash) fall through to the app shell instead of
        // reaching Django's own slash-redirect.
        //
        // /sitemap.xml and /robots.txt are real static files too (see
        // public/), not SPA routes -- without denylisting them, anyone
        // whose browser already has an older service worker installed
        // (i.e. basically every returning visitor, which is the whole
        // point of a PWA) gets served the cached app shell instead of the
        // actual file when opening either URL directly. Confirmed live:
        // works in a private tab (no service worker yet, goes straight to
        // network) but not in a normal tab with the SW already active.
        navigateFallbackDenylist: [
          /^\/admin($|\/)/,
          /^\/static($|\/)/,
          /^\/media($|\/)/,
          /^\/sitemap\.xml$/,
          /^\/robots\.txt$/,
        ],
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
