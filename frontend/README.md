# Rassemble frontend

React + Vite PWA. See the [root README](../README.md#frontend-react--vite-pwa) for setup instructions (requires the Django backend from `../backend` running alongside it).

- `src/pages/` — one file per screen
- `src/context/AppContext.jsx` — shared state: wilayas, campaigns, config, access tokens
- `src/api.js` — REST client + upload retry (Wave 2) + offline-aware creation (Wave 5)
- `src/offlineQueue.js` — IndexedDB queue for Need/Pickup/ProgressUpdate creation while offline
- `src/i18n.js`, `src/locales/*.json` — French (default) / Arabic (RTL) / English
