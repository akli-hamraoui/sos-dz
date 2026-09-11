"""Shared geocoding/text-normalization primitives for anything that turns a
loosely-structured "city/country/address" description into a real
CollectionPoint location: the partner-CSV bulk importer
(management/commands/import_collection_points.py) and the live flyer-photo
pipeline (core.gemini_extraction/core.views.FlyerSubmissionViewSet).
Extracted here so both share one Nominatim client, one fundraising-keyword
exclusion list, and one country-name/ISO table instead of drifting apart.
"""

import time
import unicodedata

import requests

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_USER_AGENT = "sosdz/1.0 (+https://sosdz.org; contact: hamraoui.akli@gmail.com)"
NOMINATIM_MIN_INTERVAL_SECONDS = 1.1  # Nominatim usage policy: max 1 req/s.


def strip_accents(text):
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c))


def normalize(text):
    return strip_accents(text or "").strip().lower()


# ---------------------------------------------------------------------------
# Exclusion: any mention of an online money-collection platform/link drops
# the whole submission, no exceptions -- see gemini_extraction.py and
# import_collection_points.py's own module docstring for why this is a
# literal keyword match by design, not a judgment call about intent.
# ---------------------------------------------------------------------------
FUNDRAISING_KEYWORDS = [
    "ccp", "paypal", "cotizup", "cagnotte", "leetchi", "gofundme", "helloasso",
    "lydia", "ulule", "kisskissbankbank", "tipeee", "patreon", "cotisation en ligne",
    "collecte de fonds en ligne", "don en ligne", "dons en ligne", "virement bancaire",
    "compte postal", "rib ",
]


def fundraising_hit(row):
    """Returns the matched keyword if ANY value in this dict mentions an
    online money-collection platform/link, else None."""
    blob = normalize(" | ".join(v or "" for v in row.values()))
    for kw in FUNDRAISING_KEYWORDS:
        if kw in blob:
            return kw
    return None


def contains_fundraising_keyword(*texts):
    """Same check as fundraising_hit, for plain strings rather than a CSV
    row dict (see gemini_extraction.py)."""
    blob = normalize(" | ".join(texts))
    return any(kw in blob for kw in FUNDRAISING_KEYWORDS)


# Curated ISO 3166-1 alpha-2 lookup for the French country names this
# project actually sees (mirrors frontend/src/countries.js's COUNTRY_CODES
# list). Extend as new countries show up -- an unmapped country name is NOT
# guessed.
COUNTRY_NAME_TO_ISO = {
    "france": "FR", "tunisie": "TN", "maroc": "MA", "libye": "LY", "egypte": "EG",
    "espagne": "ES", "italie": "IT", "allemagne": "DE", "belgique": "BE",
    "pays-bas": "NL", "hollande": "NL", "royaume-uni": "GB", "angleterre": "GB",
    "grande-bretagne": "GB", "suisse": "CH", "portugal": "PT", "suede": "SE",
    "norvege": "NO", "danemark": "DK", "finlande": "FI", "irlande": "IE",
    "autriche": "AT", "pologne": "PL", "turquie": "TR", "arabie saoudite": "SA",
    "emirats arabes unis": "AE", "emirats": "AE", "qatar": "QA", "koweit": "KW",
    "bahrein": "BH", "oman": "OM", "jordanie": "JO", "liban": "LB", "irak": "IQ",
    "syrie": "SY", "palestine": "PS", "yemen": "YE", "soudan": "SD",
    "mauritanie": "MR", "mali": "ML", "niger": "NE", "senegal": "SN",
    "cote d'ivoire": "CI", "cote divoire": "CI", "cameroun": "CM",
    "etats-unis": "US", "usa": "US", "canada": "CA", "mexique": "MX",
    "bresil": "BR", "argentine": "AR", "chili": "CL", "colombie": "CO",
    "perou": "PE", "chine": "CN", "japon": "JP", "coree du sud": "KR",
    "inde": "IN", "pakistan": "PK", "indonesie": "ID", "malaisie": "MY",
    "singapour": "SG", "thailande": "TH", "vietnam": "VN", "philippines": "PH",
    "australie": "AU", "nouvelle-zelande": "NZ", "afrique du sud": "ZA",
    "nigeria": "NG", "kenya": "KE", "ghana": "GH", "russie": "RU",
    "ukraine": "UA", "roumanie": "RO", "grece": "GR", "republique tcheque": "CZ",
    "tchequie": "CZ", "hongrie": "HU", "bulgarie": "BG", "croatie": "HR",
    "serbie": "RS", "albanie": "AL",
}

# Best-effort city-center fallback when live Nominatim geocoding isn't
# reachable. Approximate (city-center) precision only. Keyed by
# (ascii-folded lowercase city name, ISO2 country code).
OFFLINE_CITY_COORDS = {
    ("paris", "FR"): (48.8566, 2.3522),
    ("paris 5e", "FR"): (48.8448, 2.3471),
    ("alfortville", "FR"): (48.7989, 2.4172),
    ("argenteuil", "FR"): (48.9479, 2.2467),
    ("aubervilliers", "FR"): (48.9146, 2.3831),
    ("bondy", "FR"): (48.9021, 2.4831),
    ("bordeaux", "FR"): (44.8378, -0.5792),
    ("chelles", "FR"): (48.8825, 2.5928),
    ("colombes", "FR"): (48.9228, 2.2544),
    ("creteil", "FR"): (48.7904, 2.4556),
    ("delle", "FR"): (47.5175, 6.9958),
    ("les mureaux", "FR"): (48.9906, 1.9075),
    ("lille", "FR"): (50.6292, 3.0573),
    ("lyon", "FR"): (45.7640, 4.8357),
    ("mantes-la-jolie", "FR"): (48.9906, 1.7169),
    ("marseille", "FR"): (43.2965, 5.3698),
    ("massy", "FR"): (48.7263, 2.2828),
    ("mitry-mory", "FR"): (48.9614, 2.6183),
    ("montpellier", "FR"): (43.6108, 3.8767),
    ("nanterre", "FR"): (48.8924, 2.2065),
    ("nantes", "FR"): (47.2184, -1.5536),
    ("nice", "FR"): (43.7102, 7.2620),
    ("noisy-le-grand", "FR"): (48.8489, 2.5539),
    ("rennes", "FR"): (48.1173, -1.6778),
    ("saint-denis", "FR"): (48.9356, 2.3539),
    ("saint-etienne", "FR"): (45.4397, 4.3872),
    ("sarcelles", "FR"): (48.9964, 2.3810),
    ("strasbourg", "FR"): (48.5734, 7.7521),
    ("torcy", "FR"): (48.8508, 2.6553),
    ("toulouse", "FR"): (43.6047, 1.4442),
    ("valentigney", "FR"): (47.4794, 6.8358),
    ("villeparisis", "FR"): (48.9394, 2.6114),
    ("vitry-sur-seine", "FR"): (48.7876, 2.3932),
    ("evry-courcouronnes", "FR"): (48.6280, 2.4406),
    ("quaregnon", "BE"): (50.4372, 3.8749),
}

# A "ville" cell/field that's actually one of these isn't a place name at
# all -- geocoding it as free text risks a coincidental, unrelated hit.
GENERIC_NON_PLACE_TOKENS = {
    "national", "nationale", "national(e)", "toute l'algerie", "algerie entiere",
    "non precisee", "non precise", "ville non precisee", "inconnu", "inconnue",
    "a confirmer", "n/a", "na", "-",
}


def is_generic_non_place(text):
    text = normalize(text)
    if not text:
        return True
    if text in GENERIC_NON_PLACE_TOKENS:
        return True
    return any(token in text for token in ("a confirmer", "non precisee", "non precise"))


def city_query_candidates(ville):
    """Geocoding query candidates for a raw city name, most specific
    first -- see import_collection_points.py's own longer docstring for
    why a parenthetical needs special-casing. Can return an empty list
    when nothing in the text is an actual place name."""
    import re

    ville = (ville or "").strip()
    if not ville:
        return []
    base = re.sub(r"\s*\([^)]*\)\s*$", "", ville).strip()
    candidates = []
    m = re.search(r"\(([^)]*)\)\s*$", ville)
    if m:
        inner = m.group(1).strip()
        if re.search(r"[A-Za-zÀ-ÿ]", inner):
            candidates.append(inner)
    if base:
        candidates.append(base)
    if not candidates:
        candidates.append(ville)
    return [c for c in candidates if not is_generic_non_place(c)]


def split_phones(raw):
    """CollectionPoint.contact_phone is capped at 30 chars and meant for one
    identity-matching number; a cell/field listing several numbers
    (separated by '/', ',', ';' or a line break) would otherwise blow past
    that limit. Returns (first_number, remaining_numbers_or_empty_string)."""
    import re

    parts = [p.strip() for p in re.split(r"[\n/;,]+", raw or "") if p.strip()]
    if not parts:
        return "", ""
    return parts[0][:30], "\n".join(parts[1:])


class NominatimClient:
    """Thin, rate-limited, cached wrapper around the public Nominatim
    /search endpoint -- same service the frontend already uses client-side
    (frontend/src/utils.js). Fails soft: any network error is treated as
    "no result", never raised."""

    def __init__(self, stdout=None):
        self._last_call = 0.0
        self._cache = {}
        self._unavailable = False
        self.stdout = stdout

    def _throttle(self):
        elapsed = time.monotonic() - self._last_call
        if elapsed < NOMINATIM_MIN_INTERVAL_SECONDS:
            time.sleep(NOMINATIM_MIN_INTERVAL_SECONDS - elapsed)
        self._last_call = time.monotonic()

    def search(self, query, country_code=None):
        """Returns (lat, lon, display_name) for the best match, or None."""
        if not query or self._unavailable:
            return None
        cache_key = (query, country_code)
        if cache_key in self._cache:
            return self._cache[cache_key]
        self._throttle()
        params = {"q": query, "format": "json", "limit": 1, "addressdetails": 0}
        if country_code:
            params["countrycodes"] = country_code.lower()
        try:
            resp = requests.get(NOMINATIM_URL, params=params, headers={"User-Agent": NOMINATIM_USER_AGENT}, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            self._unavailable = True
            if self.stdout:
                self.stdout.write(f"  [geocoding] Nominatim unreachable ({exc}); disabling live geocoding for the rest of this run.")
            return None
        result = None
        if data:
            hit = data[0]
            try:
                result = (float(hit["lat"]), float(hit["lon"]), hit.get("display_name", query))
            except (KeyError, TypeError, ValueError):
                result = None
        self._cache[cache_key] = result
        return result
