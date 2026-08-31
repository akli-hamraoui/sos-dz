"""
Django settings for the Rassemble project.

Configuration is driven by environment variables (see .env.example at the
repo root). Nothing here should ever hold a real secret — only placeholders
and safe local-development defaults.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BASE_DIR.parent

load_dotenv(REPO_ROOT / ".env")


def env(name, default=None, required=False):
    value = os.environ.get(name, default)
    if required and (value is None or value == ""):
        raise RuntimeError(
            f"Required environment variable '{name}' is not set. "
            f"Copy .env.example to .env and fill it in."
        )
    return value


def env_bool(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


# --- Core ---------------------------------------------------------------

SECRET_KEY = env("SECRET_KEY", default="dev-insecure-secret-key-do-not-use-in-production")
DEBUG = env_bool("DEBUG", default=True)

_allowed_hosts = env("ALLOWED_HOSTS", default="localhost,127.0.0.1")
ALLOWED_HOSTS = [h.strip() for h in _allowed_hosts.split(",") if h.strip()]

_cors_origins = env("CORS_ALLOWED_ORIGINS", default="http://localhost:5173,http://127.0.0.1:5173")
CORS_ALLOWED_ORIGINS = [o.strip() for o in _cors_origins.split(",") if o.strip()]
CORS_ALLOW_CREDENTIALS = True

# --- Applications ---------------------------------------------------------

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "corsheaders",
    "core",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "core.middleware.RequestClientIPMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "config.wsgi.application"

# --- Database -------------------------------------------------------------
# Database-agnostic: local dev uses SQLite, production points to
# MySQL/PostgreSQL via DATABASE_URL-style discrete env vars. No
# SQLite-specific features (e.g. JSON1 quirks) are relied upon in the app
# code so switching engines later is a settings-only change.

DB_ENGINE = env("DB_ENGINE", default="sqlite3")

if DB_ENGINE == "sqlite3":
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": env("DB_NAME", default=str(REPO_ROOT / "db.sqlite3")),
        }
    }
else:
    DATABASES = {
        "default": {
            "ENGINE": f"django.db.backends.{DB_ENGINE}",
            "NAME": env("DB_NAME", required=True),
            "USER": env("DB_USER", required=True),
            "PASSWORD": env("DB_PASSWORD", required=True),
            "HOST": env("DB_HOST", required=True),
            "PORT": env("DB_PORT", default=""),
            "OPTIONS": {"charset": "utf8mb4"} if DB_ENGINE == "mysql" else {},
        }
    }

# --- Passwords / i18n / tz -------------------------------------------------

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LANGUAGE_CODE = "fr"
TIME_ZONE = env("TIME_ZONE", default="Africa/Algiers")
USE_I18N = True
USE_TZ = True

# --- Static / media ---------------------------------------------------------

STATIC_URL = "static/"
STATIC_ROOT = REPO_ROOT / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static"]

MEDIA_URL = "media/"
MEDIA_ROOT = REPO_ROOT / "media"

# Media storage backend: Cloudflare R2 (S3-compatible) in production, local
# filesystem in dev when R2 credentials are not configured. See Wave 2.
R2_ACCESS_KEY_ID = env("R2_ACCESS_KEY_ID", default="")
R2_SECRET_ACCESS_KEY = env("R2_SECRET_ACCESS_KEY", default="")
R2_BUCKET_NAME = env("R2_BUCKET_NAME", default="")
R2_ENDPOINT_URL = env("R2_ENDPOINT_URL", default="")
R2_PUBLIC_BASE_URL = env("R2_PUBLIC_BASE_URL", default="")

USE_R2_STORAGE = bool(R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY and R2_BUCKET_NAME and R2_ENDPOINT_URL)

if USE_R2_STORAGE:
    STORAGES = {
        "default": {"BACKEND": "core.storage_backends.R2MediaStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }
    AWS_ACCESS_KEY_ID = R2_ACCESS_KEY_ID
    AWS_SECRET_ACCESS_KEY = R2_SECRET_ACCESS_KEY
    AWS_STORAGE_BUCKET_NAME = R2_BUCKET_NAME
    AWS_S3_ENDPOINT_URL = R2_ENDPOINT_URL
    AWS_S3_ADDRESSING_STYLE = "virtual"
    AWS_DEFAULT_ACL = None
    AWS_QUERYSTRING_AUTH = False
else:
    STORAGES = {
        "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
        "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
    }

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# --- DRF --------------------------------------------------------------------

REST_FRAMEWORK = {
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PAGINATION_CLASS": "rest_framework.pagination.PageNumberPagination",
    "PAGE_SIZE": 50,
    "DEFAULT_THROTTLE_CLASSES": [],
    "DEFAULT_THROTTLE_RATES": {
        "creation": f"{int(env('RATE_LIMIT_CREATIONS_PER_HOUR', default='20'))}/hour",
    },
    "EXCEPTION_HANDLER": "core.exceptions.rassemble_exception_handler",
}

# --- Rassemble-specific configuration ---------------------------------------

# Geo bounding box for Algeria (validation of submitted lat/long on Needs
# and CollectionPoints -- see Wave 3 "geolocation restricted to Algeria").
ALGERIA_BOUNDING_BOX = {
    "lat_min": 18.9,
    "lat_max": 37.3,
    "lon_min": -8.7,
    "lon_max": 12.0,
}

# Local, offline MaxMind GeoLite2-Country database used for the IP-based
# write restriction (Wave 1 "geographic write restriction"). This file is
# NOT included in the repo (it's a MaxMind-licensed download) -- see
# README.md "GeoIP setup". When the file is absent, IP geolocation cannot
# be resolved; core.geoip falls back to "unknown" and denies non-admin
# writes only while geo_restrict_writes_to_algeria is enabled, so behaviour
# stays safe-by-default rather than silently open.
GEOIP_DB_PATH = env("GEOIP_DB_PATH", default=str(REPO_ROOT / "GeoLite2-Country.mmdb"))

# Cloudflare Turnstile (captcha) -- see .env.example.
TURNSTILE_SITE_KEY = env("TURNSTILE_SITE_KEY", default="")
TURNSTILE_SECRET_KEY = env("TURNSTILE_SECRET_KEY", default="")
TURNSTILE_ENABLED = bool(TURNSTILE_SECRET_KEY)

# NSFWJS moderation sidecar (Wave 3).
NSFWJS_SIDECAR_URL = env("NSFWJS_SIDECAR_URL", default="http://127.0.0.1:8801")
# Combined score (sum of Hentai+Porn+Sexy probabilities, 0-1) below which
# media is auto-approved, and above which it's auto-rejected. Between the
# two: queued for human review. Tuned conservatively (wide "pending" band)
# since community reporting is the documented safety net for anything this
# free, self-hosted model gets wrong either way.
NSFWJS_APPROVE_THRESHOLD = float(env("NSFWJS_APPROVE_THRESHOLD", default="0.4"))
NSFWJS_REJECT_THRESHOLD = float(env("NSFWJS_REJECT_THRESHOLD", default="0.85"))

RATE_LIMIT_CREATIONS_PER_HOUR = int(env("RATE_LIMIT_CREATIONS_PER_HOUR", default="20"))
