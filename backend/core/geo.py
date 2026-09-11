"""Server-side geo helpers for the flyer-extraction pipeline
(core.gemini_extraction, core.views.FlyerSubmissionViewSet): geocoding a
flyer's address/city via Nominatim (same free OSM service the frontend
already uses client-side, see frontend/src/utils.js), a deterministic
jitter for PRECISION_CITY points so several of them in the same city don't
render stacked on the exact same pixel, and a country-centroid lookup for
PRECISION_COUNTRY map bubbles.
"""

import hashlib
import logging
import math
import random
import time

import requests

logger = logging.getLogger(__name__)

NOMINATIM_BASE = "https://nominatim.openstreetmap.org"
# Nominatim's usage policy requires a descriptive User-Agent identifying the
# application (the default "python-requests/x.y" is routinely blocked) and
# at most 1 request/second from a single client.
_HEADERS = {"User-Agent": "SOSDZ/1.0 (sosdz.org; humanitarian aid coordination)"}
_MIN_REQUEST_INTERVAL_SECONDS = 1.0
_last_request_at = 0.0


def _throttled_get(url, params):
    global _last_request_at
    wait = _MIN_REQUEST_INTERVAL_SECONDS - (time.monotonic() - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    try:
        resp = requests.get(url, params=params, headers=_HEADERS, timeout=10)
        resp.raise_for_status()
        return resp.json()
    except Exception:
        logger.warning("Nominatim request failed: %s", url, exc_info=True)
        return None
    finally:
        _last_request_at = time.monotonic()


def geocode_address(address, city="", country=""):
    """Best-effort forward geocode of a full address. Returns (lat, lon) or
    None -- never raises, since a failed geocode should fall back to a
    coarser precision level rather than blocking the whole submission."""
    query = ", ".join(part for part in [address, city, country] if part)
    if not query.strip():
        return None
    data = _throttled_get(f"{NOMINATIM_BASE}/search", {"format": "json", "limit": 1, "q": query})
    if not data:
        return None
    return float(data[0]["lat"]), float(data[0]["lon"])


def geocode_city_centroid(city, country):
    """Same as geocode_address, but queries at city level only -- used as
    the un-jittered center point for PRECISION_CITY."""
    return geocode_address(city, country=country)


# A small set of common destinations for the Algerian diaspora, checked
# first so the vast majority of PRECISION_COUNTRY points never need a
# network call at all. Anything else falls through to Nominatim (below)
# and is cached in CountryCentroidCache after the first lookup.
_COUNTRY_CENTROIDS = {
    "algérie": (28.0, 2.6), "algeria": (28.0, 2.6),
    "france": (46.6, 2.4),
    "belgique": (50.6, 4.6), "belgium": (50.6, 4.6),
    "allemagne": (51.1, 10.4), "germany": (51.1, 10.4),
    "pays-bas": (52.2, 5.5), "netherlands": (52.2, 5.5),
    "espagne": (40.3, -3.7), "spain": (40.3, -3.7),
    "italie": (42.8, 12.6), "italy": (42.8, 12.6),
    "royaume-uni": (54.0, -2.5), "uk": (54.0, -2.5), "united kingdom": (54.0, -2.5),
    "suisse": (46.8, 8.2), "switzerland": (46.8, 8.2),
    "canada": (56.1, -106.3),
    "états-unis": (39.8, -98.6), "usa": (39.8, -98.6), "united states": (39.8, -98.6),
    "tunisie": (33.9, 9.5), "tunisia": (33.9, 9.5),
    "maroc": (31.8, -7.1), "morocco": (31.8, -7.1),
    "libye": (26.3, 17.2), "libya": (26.3, 17.2),
    "égypte": (26.8, 30.8), "egypt": (26.8, 30.8),
    "arabie saoudite": (23.9, 45.1), "saudi arabia": (23.9, 45.1),
    "émirats arabes unis": (23.4, 53.8), "uae": (23.4, 53.8),
    "qatar": (25.4, 51.2),
    "turquie": (38.9, 35.2), "turkey": (38.9, 35.2),
    "suède": (60.1, 18.6), "sweden": (60.1, 18.6),
    "norvège": (60.5, 8.5), "norway": (60.5, 8.5),
    "australie": (-25.3, 133.8), "australia": (-25.3, 133.8),
    "mauritanie": (20.3, -10.3), "mauritania": (20.3, -10.3),
    "mali": (17.6, -4.0),
    "sénégal": (14.5, -14.5), "senegal": (14.5, -14.5),
}


def get_country_centroid(country_name):
    """Returns (lat, lon) for a country name, or None if it can't be
    resolved at all. Checks the hardcoded dict first, then
    CountryCentroidCache, then geocodes via Nominatim and caches the
    result -- see module docstring."""
    from core.models import CountryCentroidCache

    key = (country_name or "").strip().lower()
    if not key:
        return None
    if key in _COUNTRY_CENTROIDS:
        return _COUNTRY_CENTROIDS[key]

    cached = CountryCentroidCache.objects.filter(name=key).first()
    if cached:
        return cached.latitude, cached.longitude

    data = _throttled_get(f"{NOMINATIM_BASE}/search", {"format": "json", "limit": 1, "country": country_name})
    if not data:
        return None
    lat, lon = float(data[0]["lat"]), float(data[0]["lon"])
    CountryCentroidCache.objects.get_or_create(name=key, defaults={"latitude": lat, "longitude": lon})
    return lat, lon


# ~1.5km jitter radius: close enough to keep the pin visually "in the
# city", far enough that two or three points in the same city don't
# overlap into one indistinguishable marker at typical city zoom levels.
JITTER_RADIUS_KM = 1.5
_KM_PER_DEGREE_LAT = 111.0


def jitter_point(lat, lon, seed):
    """Deterministic small offset around (lat, lon), so a PRECISION_CITY
    point always renders at the same spot on every page load instead of
    hopping around -- seeded from `seed` (e.g. the ExtractedCollectionPoint
    row's id) rather than true randomness."""
    rng = random.Random(int(hashlib.sha256(str(seed).encode()).hexdigest(), 16))
    angle = rng.uniform(0, 2 * math.pi)
    distance_km = rng.uniform(0.2, JITTER_RADIUS_KM)
    dlat = (distance_km / _KM_PER_DEGREE_LAT) * math.cos(angle)
    km_per_degree_lon = _KM_PER_DEGREE_LAT * math.cos(math.radians(lat)) or _KM_PER_DEGREE_LAT
    dlon = (distance_km / km_per_degree_lon) * math.sin(angle)
    return lat + dlat, lon + dlon
