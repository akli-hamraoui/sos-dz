# Deployment

**Target: Contabo VPS, Ubuntu 24.04, domain `sosdz.org`.** The steps below are the exact, copy-paste commands for standing up the whole app (backend + frontend + moderation sidecar) on one VPS with Nginx as the single public entry point. They're written to be run by whoever holds SSH access to that server -- an AI session has no path to execute them itself (no SSH tool, and this kind of sandboxed session's outbound network is HTTPS-only through a policy proxy that doesn't carry raw SSH traffic). Run each block yourself over SSH, in order; paste back any error output for help debugging it. A Railway/Render fallback is documented below as an alternative if VPS setup is ever blocking progress.

Nothing IONOS-specific is used anywhere below (no "Deploy Now") -- these are plain Ubuntu/systemd/Nginx commands, so they apply equally to Contabo, IONOS, or any other Ubuntu 22.04+/24.04 VPS with root/sudo SSH access. Both the Django backend and the built React frontend are served from this one server, via Nginx, so there's no separate static-hosting product to configure.

## VPS setup

Assumes a fresh Ubuntu 24.04 Contabo VPS, the domain `sosdz.org` (and `www.sosdz.org`, optional) already pointed at its IP via an A record, and root/sudo SSH access.

### 1. Confirm the server and install packages

```bash
ssh root@<vps-ip>   # or your sudo-capable user
lsb_release -a       # confirm Ubuntu 24.04
```

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
package is usually too old for. Install it via NodeSource here too, so it's
ready by step 7 -- **pin the 20.x line specifically, not `setup_lts.x`**.
Confirmed the hard way: `setup_lts.x` installs whatever NodeSource currently
calls "latest LTS", which by now is new enough that `@tensorflow/tfjs-node@4.22.0`
(the sidecar's actual dependency, see `moderation-sidecar/package.json`) fails
at runtime with `TypeError: (0 , util_1.isNullOrUndefined) is not a function`
-- a legacy Node builtin tfjs-node's compiled code still calls, which newer
Node releases have since removed. Node 20.x predates that removal and is what
this generation of `tfjs-node` actually targets:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # sanity check -- should print v20.x
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
nano .env   # fill in real values -- see "Required .env values" below
```

**Required `.env` values** (generate/gather these yourself -- nothing here should be invented or hardcoded by an AI session; see `.env.example` for the full commented list):

| Variable | For `sosdz.org` | Where it comes from |
|---|---|---|
| `SECRET_KEY` | (generate) | `python -c "from django.core.management.utils import get_random_secret_key; print(get_random_secret_key())"` -- run this once, paste the output, never reuse the placeholder |
| `DEBUG` | `False` | fixed |
| `ALLOWED_HOSTS` | `sosdz.org,www.sosdz.org` | your domain |
| `CORS_ALLOWED_ORIGINS` | `https://sosdz.org` | Nginx serves frontend + API from the same origin below, so this mostly matters for defense in depth |
| `CSRF_TRUSTED_ORIGINS` | `https://sosdz.org` | must match the real public HTTPS origin or admin POSTs get "CSRF Failed" |
| `FRONTEND_URL` | `https://sosdz.org` | drives Django Admin's "View site" link |
| `DB_ENGINE` | your choice | `sqlite3` (default) needs no extra setup and is fine at this app's scale; only switch to `mysql`/`postgresql` if you specifically want a separate DB server -- your call, not something to decide silently |
| `DB_NAME`/`DB_USER`/`DB_PASSWORD`/`DB_HOST`/`DB_PORT` | (yours) | only if you chose mysql/postgresql above -- leave blank for sqlite |
| `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`/`R2_BUCKET_NAME`/`R2_ENDPOINT_URL`/`R2_PUBLIC_BASE_URL` | (yours, optional) | Cloudflare dashboard, see step 6b below -- leave all blank to use local filesystem storage on this VPS instead |
| `GEOIP_DB_PATH` | (yours, optional) | free MaxMind account, see README.md "GeoIP setup" -- leave unset and the Algeria-only write restriction (Django Admin toggle) fails closed until it's installed |
| `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY` | (yours, optional) | your own Cloudflare Turnstile dashboard, see README.md -- leave blank to run without captcha |
| `NSFWJS_SIDECAR_URL` | `http://127.0.0.1:8801` | fixed, set up in step 7 |

Then run migrations, seed the reference data, and create your own admin login:

```bash
cd backend
python manage.py migrate
python manage.py seed_data          # 58 wilayas of Algeria + the default "Général" campaign -- idempotent, easy to forget, and the site is unusable without it
python manage.py collectstatic --noinput
python manage.py createsuperuser    # choose credentials interactively -- this is your own admin login, not something to hand me
cd ..
```

Build the frontend (served as static files by Nginx below -- no separate build/hosting product needed since it's all one server):

```bash
cd frontend
npm install
npm run build   # outputs frontend/dist/ -- Nginx's `root` points straight at this in step 4
cd ..
```

Gunicorn and Nginx both run as `www-data`, but everything above was created as your own SSH user. Rather than hand over ownership outright (which would then block your own `git pull` on redeploy, see step 6), share the group instead -- `www-data` gets read/write, you keep ownership, and the setgid bit means files created by either side (a `git pull`, a Django migration, an uploaded photo) keep working:

```bash
sudo chown -R $USER:www-data /opt/sos-dz
sudo chmod -R g+rwX /opt/sos-dz
sudo find /opt/sos-dz -type d -exec chmod g+s {} \;
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
# /run/ itself is root-owned (0755) -- www-data cannot create a new file
# directly inside it, so binding straight to unix:/run/sos-dz.sock fails
# with "Can't connect to /run/sos-dz.sock" and Gunicorn crash-loops
# (confirmed the hard way: this is not hypothetical). RuntimeDirectory=
# has systemd create /run/sos-dz/ owned by this service's User/Group
# *before* starting it (and clean it up on stop), so the socket goes
# inside that instead.
RuntimeDirectory=sos-dz
WorkingDirectory=/opt/sos-dz/backend
EnvironmentFile=/opt/sos-dz/.env
ExecStart=/opt/sos-dz/backend-venv/bin/gunicorn \
    --workers 3 \
    --bind unix:/run/sos-dz/sos-dz.sock \
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

### 4. Nginx: serves the frontend directly, reverse-proxies the backend

Unlike a split IONOS-Deploy-Now-plus-VPS setup, everything is one server here, so Nginx serves the built frontend (`frontend/dist/`) as static files at `/`, and only hands `/api/` and `/admin/` off to Gunicorn -- no separate frontend hosting product, no cross-origin config, no build-time `VITE_API_BASE` needed (the frontend's own relative `/api` fetch calls just work, same origin).

`/etc/nginx/sites-available/sos-dz`:

```nginx
server {
    listen 80;
    server_name sosdz.org www.sosdz.org;

    # Nginx's own default (1MB) rejects a create-need submission with a
    # generic 413 the instant a photo/voice/video is attached -- confirmed
    # live on the real deploy, and the frontend has no specific message for
    # a raw 413 (it's not a Django response at all), so it just shows the
    # generic "something went wrong" error with no clue why. Match
    # Django's own DATA_UPLOAD_MAX_MEMORY_SIZE (config/settings.py).
    client_max_body_size 30M;

    root /opt/sos-dz/frontend/dist;

    location /static/ {
        alias /opt/sos-dz/staticfiles/;
    }
    location /media/ {
        alias /opt/sos-dz/media/;
    }

    # Django Admin and the API both go to Gunicorn -- everything else
    # (the SPA's own routes: /, /needs, /needs/123, etc.) is served as
    # static files by the `location /` fallback below, since the React
    # app itself handles client-side routing for those paths.
    # `(/|$)` (not just a trailing `/`) so bare "/admin" (no slash) also
    # matches -- otherwise it fell through to the SPA fallback below,
    # which served the React app shell instead of ever reaching Django,
    # which would otherwise have 301-redirected it to "/admin/" itself.
    location ~ ^/(api|admin)(/|$) {
        proxy_pass http://unix:/run/sos-dz/sos-dz.sock;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/sos-dz /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

At this point the site is reachable over plain HTTP at `http://sosdz.org` -- confirm that works (and that DNS is actually pointing here: `dig +short sosdz.org` should print this VPS's IP) before moving to HTTPS below.

### 5. HTTPS via Let's Encrypt

Only run this once DNS for `sosdz.org` (and `www.sosdz.org`, if using it) is actually pointing at this VPS's IP -- Let's Encrypt's domain-validation challenge fails otherwise. Confirm first:

```bash
dig +short sosdz.org
dig +short www.sosdz.org   # only if you added the www A/CNAME record too
# both should print this VPS's public IP -- if not, wait for DNS to propagate before continuing
```

```bash
sudo certbot --nginx -d sosdz.org -d www.sosdz.org
```

(Drop `-d www.sosdz.org` from the command if you didn't point that subdomain here.)

Certbot edits the Nginx config in place to add the SSL server block and sets up auto-renewal via a systemd timer (`sudo systemctl status certbot.timer` to confirm). Once it completes, confirm the app is actually live:

```bash
curl -I https://sosdz.org           # expect HTTP/2 200
curl -sS https://sosdz.org/api/config/   # expect a JSON config response, not an error
```

And update `.env`'s `ALLOWED_HOSTS`/`CORS_ALLOWED_ORIGINS`/`CSRF_TRUSTED_ORIGINS`/`FRONTEND_URL` to the `https://` versions if you'd filled them in as `http://` earlier, then `sudo systemctl restart sos-dz-gunicorn`.

### 6. Redeploying on a new push

```bash
cd /opt/sos-dz
git pull
source backend-venv/bin/activate
pip install -r backend/requirements.txt
cd backend
python manage.py migrate
python manage.py collectstatic --noinput
cd ../frontend
npm install
npm run build   # re-generates frontend/dist/ -- Nginx picks it up immediately, no restart needed
cd ..
sudo systemctl restart sos-dz-gunicorn
```

(`moderation-sidecar/` only needs its own `npm install` again if `moderation-sidecar/package.json` changed -- see step 7.)

### 6b. Cloudflare R2 (media storage, Wave 2)

Create an R2 bucket in the Cloudflare dashboard, generate an S3-compatible API token (Account Home -> R2 -> Manage API Tokens), and set in `.env`: `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ENDPOINT_URL` (looks like `https://<account-id>.r2.cloudflarestorage.com`), and `R2_PUBLIC_BASE_URL` if the bucket has a public custom domain attached. When these are unset, the app automatically falls back to local filesystem storage (`media/` on the server) -- convenient for a first deploy, but means uploaded photos/audio/video live only on that one VPS with no CDN/egress-fee-free delivery, which defeats the point for a project this spec-sensitive about weak connections. Set the R2 variables before considering the app production-ready.

### 7. NSFWJS moderation sidecar (Wave 3)

Small Node.js service (`moderation-sidecar/`) wrapping NSFWJS -- free, open-source, MIT-licensed, self-hosted, no API key or billing account. The classification model ships bundled inside the `nsfwjs` npm package itself, so this needs **no external network access at all** once `npm install` has run (confirmed in development: `nsfw.load()` loads the model entirely from local files).

```bash
cd /opt/sos-dz/moderation-sidecar
npm install --production
```

A recent `npm` blocks dependency install scripts by default as a security
measure -- `@tensorflow/tfjs-node` needs its own install script to run
(`node-gyp rebuild`, which compiles/downloads its native bindings) or it
won't work at all. If `npm install` warns `N packages have install scripts
not yet covered by allowScripts`, approve the two that need it (both are
legitimate, expected, and already covered by the accepted-risk note below)
and rebuild:

```bash
npm install-scripts approve @tensorflow/tfjs-node
npm install-scripts approve core-js
npm rebuild @tensorflow/tfjs-node
npm rebuild core-js
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

If VPS setup is ever blocking progress, either Railway or Render can host the Django backend directly from the GitHub repo with minimal config (the frontend would then need its own separate static host too, e.g. Cloudflare Pages/Netlify/Vercel, since this fallback is backend-only):

1. Create a new project from the `akli-hamraoui/sos-dz` repo, root directory `backend/`.
2. Build command: `pip install -r requirements.txt`.
3. Start command: `gunicorn config.wsgi:application`.
4. Set the same environment variables as `.env.example` (SECRET_KEY, DEBUG=False, ALLOWED_HOSTS, DB_*, R2_*, etc.) in the platform's dashboard — never commit them.
5. Add a managed MySQL/PostgreSQL add-on (Railway) or a Render PostgreSQL instance, and point `DB_*` at it.
6. Run `python manage.py migrate` via the platform's one-off command/shell after first deploy.

This is meant to be temporary, to keep momentum — the Contabo VPS (above) remains the intended target.

The old Wave 1-4 plain HTML/Alpine.js frontend (`backend/templates/`, `backend/static/js/app.js`) doesn't need a deploy step of its own -- it's kept for reference/history but is not what ships from Wave 5 onward, is no longer served at any live route (see `config/urls.py`), and predates the fr/en/ar i18n work so was always English-only.
