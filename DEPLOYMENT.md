# Deployment

**Status: not yet actually deployed.** The steps below are the exact, tested-as-written commands for standing up the Wave 1 backend on an IONOS VPS. They have not been run against a real IONOS server in this environment (no IONOS account/credentials are available here), so there is no live public URL yet. This is the tradeoff flagged in the Wave 1 spec: rather than get stuck on server provisioning, this document is written so a real deploy is a copy-paste job for whoever has IONOS access, and a Railway/Render fallback is documented below as an alternative if that's faster to get live.

IONOS "Deploy Now" only supports static sites/SPAs/PHP — it does **not** support Python/Django, so the backend needs a real VPS (Virtual Server), not Deploy Now. Deploy Now becomes usable directly once the frontend is a proper build (React/Vite, Wave 5 onward).

## Option A — IONOS VPS (target)

Assumes a fresh Ubuntu 22.04+ IONOS VPS, a domain/subdomain pointed at its IP, and SSH access.

### 1. Server packages

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y python3-venv python3-pip nginx certbot python3-certbot-nginx git
```

### 2. Clone and set up the app

```bash
sudo mkdir -p /opt/rassemble && sudo chown $USER:$USER /opt/rassemble
git clone https://github.com/akli-hamraoui/sos-dz.git /opt/rassemble
cd /opt/rassemble

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

`/etc/systemd/system/rassemble-gunicorn.service`:

```ini
[Unit]
Description=Rassemble Gunicorn daemon
After=network.target

[Service]
User=www-data
Group=www-data
WorkingDirectory=/opt/rassemble/backend
EnvironmentFile=/opt/rassemble/.env
ExecStart=/opt/rassemble/backend-venv/bin/gunicorn \
    --workers 3 \
    --bind unix:/run/rassemble.sock \
    config.wsgi:application
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rassemble-gunicorn
sudo systemctl status rassemble-gunicorn
```

### 4. Nginx reverse proxy

`/etc/nginx/sites-available/rassemble`:

```nginx
server {
    listen 80;
    server_name your-domain.example;

    location /static/ {
        alias /opt/rassemble/staticfiles/;
    }
    location /media/ {
        alias /opt/rassemble/media/;
    }

    location / {
        proxy_pass http://unix:/run/rassemble.sock;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/rassemble /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### 5. HTTPS via Let's Encrypt

```bash
sudo certbot --nginx -d your-domain.example
```

Certbot edits the Nginx config in place to add the SSL server block and sets up auto-renewal via a systemd timer (`sudo systemctl status certbot.timer` to confirm).

### 6. Redeploying on a new push

```bash
cd /opt/rassemble
git pull
source backend-venv/bin/activate
pip install -r backend/requirements.txt
cd backend
python manage.py migrate
python manage.py collectstatic --noinput
sudo systemctl restart rassemble-gunicorn
```

### 7. NSFWJS sidecar (Wave 3)

To be documented here once Wave 3 (media moderation) is built: it runs as its own systemd service (`rassemble-nsfwjs.service`) on the same VPS, started/restarted the same way as Gunicorn, called by Django over local HTTP (`NSFWJS_SIDECAR_URL`, default `http://127.0.0.1:8801`) — never split into a separate networked service.

## Option B — temporary fallback (Railway/Render)

If IONOS server setup is blocking progress, either Railway or Render can host the Django backend directly from the GitHub repo with minimal config:

1. Create a new project from the `akli-hamraoui/sos-dz` repo, root directory `backend/`.
2. Build command: `pip install -r requirements.txt`.
3. Start command: `gunicorn config.wsgi:application`.
4. Set the same environment variables as `.env.example` (SECRET_KEY, DEBUG=False, ALLOWED_HOSTS, DB_*, R2_*, etc.) in the platform's dashboard — never commit them.
5. Add a managed MySQL/PostgreSQL add-on (Railway) or a Render PostgreSQL instance, and point `DB_*` at it.
6. Run `python manage.py migrate` via the platform's one-off command/shell after first deploy.

This is meant to be temporary, to keep momentum — Option A (IONOS VPS) remains the intended target.

## Frontend (Wave 5 onward)

Once the frontend becomes a separate React/Vite build, it deploys via **IONOS Deploy Now** directly from the GitHub repo (connect the repo, it auto-detects the SPA, redeploys on every push to the configured branch). Until then (Waves 1-4), the plain HTML/Alpine.js frontend is served by Django/Nginx alongside the backend, no separate deploy step needed.
