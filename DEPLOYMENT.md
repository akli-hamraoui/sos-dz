# Deployment

**Status: not yet actually deployed.** The steps below are the exact, tested-as-written commands for standing up the Wave 1 backend on an IONOS VPS. They have not been run against a real IONOS server in this environment (no IONOS account/credentials are available here), so there is no live public URL yet. This is the tradeoff flagged in the Wave 1 spec: rather than get stuck on server provisioning, this document is written so a real deploy is a copy-paste job for whoever has IONOS access, and a Railway/Render fallback is documented below as an alternative if that's faster to get live.

IONOS "Deploy Now" only supports static sites/SPAs/PHP — it does **not** support Python/Django, so the backend needs a real VPS (Virtual Server), not Deploy Now. Deploy Now becomes usable directly once the frontend is a proper build (React/Vite, Wave 5 onward).

## Option A — IONOS VPS (target)

Assumes a fresh Ubuntu 22.04+ IONOS VPS, a domain/subdomain pointed at its IP, and SSH access.

### 1. Server packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3-venv python3-pip nginx certbot python3-certbot-nginx git ffmpeg
```

`ffmpeg` (and the `ffprobe` binary that ships with it) is what step 7's video
duration check and moderation frame extraction use. The server-side duration
check itself is gated behind `AppConfiguration.enforce_video_duration_check`
in Django Admin, **off by default** precisely so a server without ffmpeg
installed doesn't reject every video submission outright -- but when that
setting is turned on, it does not degrade gracefully like the other optional
integrations (R2, MaxMind, Turnstile, the NSFWJS sidecar itself): an
unverifiable duration is rejected rather than silently accepted. Install
ffmpeg here, in the very first command block of the deploy, so it's already
in place by the time you decide whether to turn that setting on -- and so
frame-by-frame video moderation (which does degrade gracefully, queuing
"pending" instead) works either way.

The moderation sidecar (step 7) also needs Node.js, which Ubuntu's own `apt`
package is usually too old for (`@tensorflow/tfjs-node` needs a reasonably
recent Node). Install a current LTS via NodeSource here too, so it's ready
by step 7:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # sanity check -- should print a v20+ (or later LTS) version
```

### 2. Clone and set up the app

```bash
sudo mkdir -p /opt/sos-dz && sudo chown $USER:$USER /opt/sos-dz
git clone https://github.com/akli-hamraoui/sos-dz.git /opt/sos-dz
cd /opt/sos-dz

python3 -m venv backend-venv
source backend-venv/bin/activate
pip install -r backend/requirements.txt

cp .env.example .env
# Edit .env: generate a real SECRET_KEY, set DEBUG=False, set ALLOWED_HOSTS
# to your domain, set DB_ENGINE=mysql (or postgresql) with real DB
# credentials, set R2_* if using Cloudflare R2 for media. Never commit this
# file -- it stays only on the server.
nano .env

cd backend
python manage.py migrate
python manage.py collectstatic --noinput
python manage.py createsuperuser   # choose credentials interactively
```

### 3. Gunicorn systemd service

`/etc/systemd/system/sos-dz-gunicorn.service`:

```ini
[Unit]
Description=SOS DZ Gunicorn daemon
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/opt/sos-dz/backend
EnvironmentFile=/opt/sos-dz/.env
ExecStart=/opt/sos-dz/backend-venv/bin/gunicorn \
    --workers 3 \
    --bind unix:/run/sos-dz.sock \
    config.wsgi:application
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sos-dz-gunicorn
sudo systemctl status sos-dz-gunicorn
```

### 4. Nginx reverse proxy

`/etc/nginx/sites-available/sos-dz`:

```nginx
server {
    listen 80;
    server_name your-domain.example;

    location /static/ {
        alias /opt/sos-dz/staticfiles/;
    }
    location /media/ {
        alias /opt/sos-dz/media/;
    }

    location / {
        proxy_pass http://unix:/run/sos-dz.sock;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sos-dz /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. HTTPS via Let's Encrypt

```bash
sudo certbot --nginx -d your-domain.example
```

Certbot edits the Nginx config in place to add the SSL server block and sets up auto-renewal via a systemd timer (`sudo systemctl status certbot.timer` to confirm).

### 6. Redeploying on a new push

```bash
cd /opt/sos-dz
git pull
source backend-venv/bin/activate
pip install -r backend/requirements.txt
cd backend
python manage.py migrate
python manage.py collectstatic --noinput
sudo systemctl restart sos-dz-gunicorn
```

### 6b. Cloudflare R2 (media storage, Wave 2)

Create an R2 bucket in the Cloudflare dashboard, generate an S3-compatible API token (Account Home -> R2 -> Manage API Tokens), and set in `.env`: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT_URL` (looks like `https://<account-id>.r2.cloudflarestorage.com`), and `R2_PUBLIC_BASE_URL` if the bucket has a public custom domain attached. When these are unset, the app automatically falls back to local filesystem storage (`media/` on the server) -- convenient for a first deploy, but means uploaded photos/audio/video live only on that one VPS with no CDN/egress-fee-free delivery, which defeats the point for a project this spec-sensitive about weak connections. Set the R2 variables before considering the app production-ready.

### 7. NSFWJS moderation sidecar (Wave 3)

Small Node.js service (`moderation-sidecar/`) wrapping NSFWJS -- free, open-source, MIT-licensed, self-hosted, no API key or billing account. The classification model ships bundled inside the `nsfwjs` npm package itself, so this needs **no external network access at all** once `npm install` has run (confirmed in development: `nsfw.load()` loads the model entirely from local files).

```bash
cd /opt/sos-dz/moderation-sidecar
npm install --production
```

`/etc/systemd/system/sos-dz-nsfwjs.service`:

```ini
[Unit]
Description=SOS DZ NSFWJS moderation sidecar
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/opt/sos-dz/moderation-sidecar
Environment=HOST=127.0.0.1
Environment=PORT=8801
ExecStart=/usr/bin/node server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now sos-dz-nsfwjs
curl http://127.0.0.1:8801/health   # {"status":"ok","model_loaded":true}
```

It binds to `127.0.0.1` only (never exposed publicly) and is called by Django over local HTTP at `NSFWJS_SIDECAR_URL` (default `http://127.0.0.1:8801`, see `.env.example`). This is a deliberate, documented exception to the "single monolith" architecture -- see `moderation-sidecar/server.js`'s header comment for why.

**Video frame extraction requires `ffmpeg` on PATH**, already installed back in step 1, for `core/media_validation.py`'s duration check and `core/moderation.py`'s frame-by-frame video moderation. Video moderation degrades gracefully without it (queues for manual review instead of auto-approving). Server-side video duration verification is a separate, opt-in setting -- **`AppConfiguration.enforce_video_duration_check` in Django Admin, off by default**. Leave it off and video reports go through unverified (relying on the client-side 20s auto-stop only) even without ffmpeg. Turn it on once ffmpeg is confirmed installed (`ffprobe -version`) if you want the 20s cap actually enforced server-side -- once on, it fails closed: an unverifiable duration is rejected outright rather than accepted.

**Known accepted risk**: `npm audit` on `moderation-sidecar/` reports 4 vulnerabilities (3 high, 1 critical) in `@tensorflow/tfjs-node`'s own transitive *install-time* dependencies (`@mapbox/node-pre-gyp` -> `tar`/`adm-zip`, used only to fetch tfjs-node's native binary during `npm install`, not part of the running server's request-handling code). `npm audit fix --force` would downgrade `@tensorflow/tfjs-node` to 0.1.11, an unusably ancient version -- not a real fix. This is a common, currently-unresolved upstream situation for `@tensorflow/tfjs-node` consumers; re-check `npm audit` periodically for an upstream fix.

### 8. Route tracing on the live delivery map (Wave 5+)

The Need detail page's live tracking map draws a real road-following route (distance + ETA) from a responder's last known position to the need's destination, via OSRM (Open Source Routing Machine) -- the free/open routing engine behind most non-Google routing UIs, using OpenStreetMap's road data. See `frontend/src/routing.js`.

By default it calls the public demo server (`https://router.project-osrm.org`), which needs **no setup, no API key** -- but it's explicitly a demo instance with no uptime/rate guarantees, not meant for real production traffic. Once usage justifies it, self-host OSRM (official Docker image, pre-built for several regions including Africa) and point the frontend at it via a `VITE_OSRM_BASE_URL` build-time env var. If the routing service is unreachable, the map still shows the responder's actual GPS trail (unaffected) and simply omits the projected route line/distance, rather than failing the page.

## Option B — temporary fallback (Railway/Render)

If IONOS server setup is blocking progress, either Railway or Render can host the Django backend directly from the GitHub repo with minimal config:

1. Create a new project from the `akli-hamraoui/sos-dz` repo, root directory `backend/`.
2. Build command: `pip install -r requirements.txt`.
3. Start command: `gunicorn config.wsgi:application`.
4. Set the same environment variables as `.env.example` (SECRET_KEY, DEBUG=False, ALLOWED_HOSTS, DB_*, R2_*, etc.) in the platform's dashboard — never commit them.
5. Add a managed MySQL/PostgreSQL add-on (Railway) or a Render PostgreSQL instance, and point `DB_*` at it.
6. Run `python manage.py migrate` via the platform's one-off command/shell after first deploy.

This is meant to be temporary, to keep momentum — Option A (IONOS VPS) remains the intended target.

## Frontend (Wave 5+): React/Vite PWA via IONOS Deploy Now

The frontend is now `frontend/`, a React + Vite PWA, deployed separately from the Django backend:

1. In the IONOS control panel, connect **Deploy Now** to this GitHub repo, with the app root set to `frontend/` and build command `npm run build` (output directory `frontend/dist/`). It auto-detects the Vite/SPA setup and redeploys on every push to the configured branch.
2. Set an environment/build variable so the built app's `/api` and `/media` requests reach the Django backend's real domain instead of the dev-only Vite proxy -- either configure IONOS Deploy Now's URL rewrite/reverse-proxy rules for `/api/*` and `/media/*` to point at the IONOS VPS backend, or point the frontend at an absolute backend URL (e.g. via a `VITE_API_BASE` build-time env var) if Deploy Now doesn't support path-based proxying to an external origin -- confirm whichever path is used against the actual backend domain once both are live.
3. **PWA/service worker note**: the manifest's `start_url` and the service worker are same-origin by design (`vite-plugin-pwa`'s default `generateSW` mode) -- serve the frontend and its `/api` calls from the same public origin (via the reverse-proxy rules above) so the installed PWA and its offline cache work correctly; a cross-origin API without the rewrite will still function for online use but the offline-queue's "already cached" GET responses would be scoped to the frontend's own origin only.
4. Update `CORS_ALLOWED_ORIGINS` **and** `FRONTEND_URL` in the backend's `.env` to the real frontend domain once it's live (see `.env.example`). `FRONTEND_URL` drives Django Admin's "View site" link and the backend's own "/" redirect -- left at its localhost default, both would point at the dev-only Vite server instead of the real deployed frontend.

The old Wave 1-4 plain HTML/Alpine.js frontend (`backend/templates/`, `backend/static/js/app.js`) no longer needs a deploy step of its own -- it's kept for reference/history but is not what ships from Wave 5 onward, is no longer served at any live route (see `config/urls.py`), and predates the fr/en/ar i18n work so was always English-only.
