# SOS DZ

Open-source disaster relief coordination app for Algeria (wildfires, earthquakes, floods, etc.). SOS DZ does **not** do disaster detection — it only coordinates humanitarian aid once a crisis has been declared by the relevant authorities.

Built for speed and simplicity in an emergency: creating a need or taking charge of one takes a handful of fields, no account, no SMS verification.

Full specification: see [`rassemble-spec.md`](./rassemble-spec.md) if present in your checkout, or the project's design docs.

## Status

Built wave by wave (see `docs/audits/` for the honest per-wave verification write-up):

- **Wave 1: core.** Needs, Pickups, Campaigns, Wilayas, admin dashboard (Django Admin), token-based citizen "authentication", PII anonymization, live-location map with access control, Algeria IP write restriction, rate limiting.
- **Wave 2: media.** Photo/voice/video capture (camera/mic only, no gallery import), client-side compression, Cloudflare R2 storage.
- **Wave 3: security.** Real self-hosted NSFWJS moderation (`moderation-sidecar/`), duplicate-need detection, GPS bounding-box + IP geofencing.
- **Wave 4: community.** Collection points, comments (one level of replies).
- **Wave 5: PWA + i18n.** The frontend is now a React + Vite PWA (`frontend/`) — installable, offline-first (IndexedDB queue for Need/Pickup/ProgressUpdate creation while offline, auto-synced on reconnect), French/Arabic/English with full RTL support for Arabic. The plain HTML/Alpine.js frontend from Waves 1-4 has been fully replaced.

## Local development setup (under 5 minutes)

Requires Python 3.11+. No need to install MySQL/PostgreSQL locally — SQLite is used for local dev.

```bash
# 1. Clone and enter the repo
git clone <this-repo-url>
cd sos-dz

# 2. Copy the environment file and fill in SECRET_KEY (see below)
cp .env.example .env
python3 -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"
# paste the printed value into .env as SECRET_KEY=...
# (this command needs Django installed -- if it fails, just install requirements first, see step 4, then re-run it)

# 3. Create and activate a virtual environment
python3 -m venv backend-venv
source backend-venv/bin/activate   # Windows: backend-venv\Scripts\activate

# 4. Install dependencies
pip install -r backend/requirements.txt

# 5. Run migrations (this also seeds the 58 wilayas of Algeria and the
#    default "Général" campaign automatically via a data migration)
cd backend
python manage.py migrate

# 6. Create your admin account -- you will be prompted interactively for a
#    username/password. Never share or commit these.
python manage.py createsuperuser

# 7. Start the dev server
python manage.py runserver
```

Open http://localhost:8000/ for the app, and http://localhost:8000/admin/ for the Django Admin dashboard (disaster types, campaigns, moderation, config toggles). A logged-in admin can switch the admin site's own interface language (French/English/Arabic, top-right dropdown) independently of the public app's language.

**Always use the same hostname (`localhost`, not `127.0.0.1`) for both Django Admin and the frontend below.** Django's session cookie is host-only -- `localhost` and `127.0.0.1` never share it, even on the same machine -- so logging into `/admin/` on one and browsing the frontend on the other silently drops the admin bypass (e.g. the GeoIP write restriction below applies again as if you were logged out, or Django Admin's "View site" link opens a host the admin session doesn't reach).

If a required environment variable is missing, the app fails immediately with a clear error message rather than starting in a broken state.

### GeoIP setup (optional for local dev)

`AppConfiguration.geo_restrict_writes_to_algeria` (enabled by default) blocks non-admin writes (creating/editing a Need, Pickup, Comment, CollectionPoint) from IP addresses that don't geolocate to Algeria, using a local, offline MaxMind GeoLite2-Country database. **This database is not included in the repo** (MaxMind requires a free account to download it) and testing from `localhost` does not count as an Algerian IP, so out of the box this restriction will block anonymous write requests during local testing. Two ways to test anyway, both intentional (see spec):

- (a) Log in as the admin you created in step 6 (`request.user.is_staff`) — admins always bypass this check, from anywhere, **as long as you browse the frontend on the same hostname you logged into `/admin/` with** (see the hostname note above — this is the #1 reason the bypass silently doesn't apply).
- (b) Temporarily set `geo_restrict_writes_to_algeria` to "No" for the one `AppConfiguration` row in Django Admin.

To actually install the real database: create a free account at https://www.maxmind.com/en/geolite2/signup, download `GeoLite2-Country.mmdb`, and either place it at the repo root (default `GEOIP_DB_PATH`) or point `GEOIP_DB_PATH` in `.env` at wherever you put it. Never commit the `.mmdb` file (it's gitignored) — MaxMind's license does not allow redistributing it.

### Moderation sidecar (optional for local dev)

Photo/video moderation (Wave 3) calls a small local NSFWJS service. Without it running, uploads that need moderation are simply queued as "pending" (safe default -- see `core/moderation.py`) rather than auto-approved. To run it locally:

```bash
cd moderation-sidecar
npm install
npm start   # listens on http://127.0.0.1:8801, no model download needed -- it's bundled in the npm package
```

### Admin-manageable translations

An admin can correct a piece of UI text from Django Admin ("Translation overrides") without a frontend deploy: add a row with the locale (fr/en/ar), the dotted key exactly as used in the frontend (e.g. `home.tagline`, `createNeed.name` -- see `frontend/src/locales/*.json` for the available keys), and the replacement text. The frontend fetches all overrides at startup (`/api/translations/`) and merges them over the static locale JSON bundles, so a key with no override just keeps using the static file's value.

### Logging

The backend logs to both the console and a rotating file at `logs/django.log` (repo root by default, gitignored -- 5MB x 5 backups). Override the location or verbosity with `LOG_DIR`/`LOG_LEVEL` in `.env` if needed.

### Running tests

```bash
cd backend
python manage.py test core
```

## Frontend (React + Vite PWA)

Requires Node.js 20+. The dev server proxies `/api` and `/media` to the Django backend, so run both at once.

```bash
# Terminal 1: backend (see above)
cd backend && python manage.py runserver

# Terminal 2: frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:5173/ (see the hostname note above -- use `localhost` here too, matching Django Admin). To try the installable/offline PWA build specifically (the dev server doesn't run a real service worker):

```bash
cd frontend
npm run build
npm run preview -- --port 4173   # also proxies /api and /media
```

Language switches between French (default), Arabic (RTL), and English from the nav bar; the choice persists in `localStorage`.

## Architecture

Single monolithic Django project (Django + Django REST Framework), not microservices — simpler to build, deploy, and debug for a small/solo project. The one deliberate exception (Wave 3) is NSFWJS, which runs as a small local sidecar process because it's a Node/TensorFlow.js model that can't run inside the Python process — that's an implementation detail, not a services split.

- **Backend**: `backend/` — Django + DRF, SQLite locally / MySQL or PostgreSQL in production (database-agnostic code, no SQLite-specific features relied upon).
- **Frontend**: `frontend/` — React + Vite PWA, a separate deployable static build (talks to the backend only over the REST API). `backend/templates/` and `backend/static/js/app.js` still hold the original Wave 1-4 plain HTML/Alpine.js frontend for reference/history; it's no longer the maintained frontend as of Wave 5.
- **Media storage**: Cloudflare R2 (S3-compatible) in production; falls back to local filesystem storage automatically when R2 credentials are not set in `.env` (convenient for local dev).

## Deployment

**Live at [sosdz.org](https://sosdz.org).** See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the exact VPS setup (Gunicorn + Nginx + systemd + Let's Encrypt) and the routine redeploy command, plus a temporary Railway/Render fallback.

## Security notes

- No real secret is ever committed to this repository. `.env.example` only holds placeholders; the actual `.env` file is gitignored. `createsuperuser` credentials are chosen interactively and never written anywhere.
- All permission rules (read-only mode, authorized wilayas, geo write restriction, ownership/token checks) are enforced **server-side**, never only in the frontend.

## License

MIT — see [`LICENSE`](./LICENSE). Contributions welcome; please open an issue or PR.
