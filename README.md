# Rassemble

Open-source disaster relief coordination app for Algeria (wildfires, earthquakes, floods, etc.). Rassemble does **not** do disaster detection — it only coordinates humanitarian aid once a crisis has been declared by the relevant authorities.

Built for speed and simplicity in an emergency: creating a need or taking charge of one takes a handful of fields, no account, no SMS verification.

Full specification: see [`rassemble-spec.md`](./rassemble-spec.md) if present in your checkout, or the project's design docs.

## Status

This repository is being built wave by wave:

- **Wave 1 (this version): core.** Needs, Pickups, Campaigns, Wilayas, admin dashboard (Django Admin), token-based citizen "authentication", PII anonymization, live-location map with access control, Algeria IP write restriction, rate limiting. Frontend is plain HTML/Alpine.js — no build step yet.
- Wave 2+: media capture, automatic moderation, duplicate detection, collection points, comments, PWA/offline, i18n (French/Arabic/English). See `CHANGELOG`-style notes in later commits.

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

Open http://127.0.0.1:8000/ for the app, and http://127.0.0.1:8000/admin/ for the Django Admin dashboard (disaster types, campaigns, moderation, config toggles).

If a required environment variable is missing, the app fails immediately with a clear error message rather than starting in a broken state.

### GeoIP setup (optional for local dev)

`AppConfiguration.geo_restrict_writes_to_algeria` (enabled by default) blocks non-admin writes (creating/editing a Need, Pickup, Comment, CollectionPoint) from IP addresses that don't geolocate to Algeria, using a local, offline MaxMind GeoLite2-Country database. **This database is not included in the repo** (MaxMind requires a free account to download it) and testing from `localhost` does not count as an Algerian IP, so out of the box this restriction will block anonymous write requests during local testing. Two ways to test anyway, both intentional (see spec):

- (a) Log in as the admin you created in step 6 (`request.user.is_staff`) — admins always bypass this check, from anywhere.
- (b) Temporarily set `geo_restrict_writes_to_algeria` to "No" for the one `AppConfiguration` row in Django Admin.

To actually install the real database: create a free account at https://www.maxmind.com/en/geolite2/signup, download `GeoLite2-Country.mmdb`, and either place it at the repo root (default `GEOIP_DB_PATH`) or point `GEOIP_DB_PATH` in `.env` at wherever you put it. Never commit the `.mmdb` file (it's gitignored) — MaxMind's license does not allow redistributing it.

### Moderation sidecar (optional for local dev)

Photo/video moderation (Wave 3) calls a small local NSFWJS service. Without it running, uploads that need moderation are simply queued as "pending" (safe default -- see `core/moderation.py`) rather than auto-approved. To run it locally:

```bash
cd moderation-sidecar
npm install
npm start   # listens on http://127.0.0.1:8801, no model download needed -- it's bundled in the npm package
```

### Running tests

```bash
cd backend
python manage.py test core
```

## Architecture

Single monolithic Django project (Django + Django REST Framework), not microservices — simpler to build, deploy, and debug for a small/solo project. The one deliberate exception (Wave 3) is NSFWJS, which runs as a small local sidecar process because it's a Node/TensorFlow.js model that can't run inside the Python process — that's an implementation detail, not a services split.

- **Backend**: `backend/` — Django + DRF, SQLite locally / MySQL or PostgreSQL in production (database-agnostic code, no SQLite-specific features relied upon).
- **Frontend**: served by Django in Wave 1-4 (plain HTML/Alpine.js, `backend/templates/index.html` + `backend/static/`); migrates to a separate React/Vite PWA in Wave 5 (`frontend/`).
- **Media storage**: Cloudflare R2 (S3-compatible) in production; falls back to local filesystem storage automatically when R2 credentials are not set in `.env` (convenient for local dev).

## Deployment

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the exact IONOS VPS setup (Gunicorn + Nginx + systemd + Let's Encrypt), plus a temporary Railway/Render fallback. **Not yet actually deployed** — no live public URL exists yet; see that file for why.

## Security notes

- No real secret is ever committed to this repository. `.env.example` only holds placeholders; the actual `.env` file is gitignored. `createsuperuser` credentials are chosen interactively and never written anywhere.
- All permission rules (read-only mode, authorized wilayas, geo write restriction, ownership/token checks) are enforced **server-side**, never only in the frontend.

## License

MIT — see [`LICENSE`](./LICENSE). Contributions welcome; please open an issue or PR.
