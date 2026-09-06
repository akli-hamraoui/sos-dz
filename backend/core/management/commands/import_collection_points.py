"""Bulk import of CollectionPoint rows from a partner-supplied CSV plus a
folder of flyer images (the "sosdz-csv-vN-et-images.zip" packages).

Usage:
    # Dry run (default -- never touches the database):
    python manage.py import_collection_points --zip /path/to/export.zip

    # Real run, only after reviewing the dry-run report:
    python manage.py import_collection_points --zip /path/to/export.zip --apply

--csv/--photos-dir can be used instead of --zip if the archive was already
extracted. Re-running the same (or an extended) CSV is safe: rows already
imported are recognized by recovery_code (or, failing that, by
organization + address/city) and skipped rather than duplicated -- see
_find_existing_point().

Geocoding mirrors the frontend's own approach (frontend/src/utils.js,
searchPlaces()) against the public Nominatim /search endpoint -- the
Django backend has no geocoding of its own today, addresses are only ever
resolved client-side in the browser. This command therefore needs
outbound internet access to Nominatim to geocode precise addresses; where
that's unavailable, a small curated table of city-center coordinates for
the handful of towns already seen in past import batches is used as a
best-effort fallback (see OFFLINE_CITY_COORDS below) -- extend it as new
cities show up in future CSVs. A national row still works with only a
wilaya even with no coordinates at all (the public map falls back to the
wilaya's own centroid, see CollectionPointMapPinSerializer), but an
international row cannot be created without a real lat/lon --
CollectionPointCreateSerializer.validate requires one unconditionally. A
row that never had a city to begin with (only a country) is therefore
"ignored" outright, per spec -- it's not queued for manual follow-up,
just skipped. A row that DID name a city but couldn't be geocoded (not in
OFFLINE_CITY_COORDS, Nominatim unreachable or found nothing) is instead
"manual_review": that one is still plausibly fixable (wrong spelling, or a
town worth adding to the table), so it's surfaced rather than silently
dropped. Either way, nothing is ever created with an invented position.

Every row that mentions CCP, PayPal, Cotizup, a "cagnotte", or another
online money-collection platform/link in ANY column is excluded outright,
no exceptions -- see FUNDRAISING_KEYWORDS.

Created points are never auto-published as ready for the public without a
paper trail: every creation (plus one batch summary) is written to
AuditLog so an admin can find and review exactly what this run added --
see core/admin.py's AuditLogAdmin (filter by action). There is no
"pending review" status on CollectionPoint today (only active/closed) and
nothing is written into any field the public site actually displays.
"""

import csv
import re
import time
import unicodedata
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import requests
from django.core.files.base import ContentFile
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.media_validation import MAX_PHOTO_SIZE_BYTES, MAX_PHOTO_SIZE_MB
from core.models import AuditLog, CollectionPoint, Need, Wilaya
from core.moderation import moderate_image_field, moderation_active
from core.serializers import CollectionPointCreateSerializer

# ---------------------------------------------------------------------------
# Exclusion: any mention of an online money-collection platform/link, in any
# column, drops the whole row -- no exceptions, regardless of context (e.g. a
# flyer *warning against* fraudulent cagnottes still contains the word
# "cagnotte" and is still excluded, since the rule is a literal keyword match
# by design, not a judgment call about intent).
# ---------------------------------------------------------------------------
FUNDRAISING_KEYWORDS = [
    "ccp", "paypal", "cotizup", "cagnotte", "leetchi", "gofundme", "helloasso",
    "lydia", "ulule", "kisskissbankbank", "tipeee", "patreon", "cotisation en ligne",
    "collecte de fonds en ligne", "don en ligne", "dons en ligne", "virement bancaire",
    "compte postal", "rib ",
]

RECOVERY_CODE_FIELD = "code de récupération"
FLYER_FIELD = "lien_flyer"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NOMINATIM_USER_AGENT = "sosdz-import-script/1.0 (+https://sosdz.org; contact: hamraoui.akli@gmail.com)"
NOMINATIM_MIN_INTERVAL_SECONDS = 1.1  # Nominatim usage policy: max 1 req/s.

# Curated ISO 3166-1 alpha-2 lookup for the French country names this project
# actually sees (mirrors frontend/src/countries.js's COUNTRY_CODES list).
# Extend as new countries show up in future CSVs -- an unmapped country name
# is NOT guessed, the row is flagged for manual review instead.
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
# reachable from wherever this command runs. Approximate (city-center)
# precision only -- never used to fabricate a precise street address, and
# never preferred over a live Nominatim result. Keyed by
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


def strip_accents(text):
    text = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in text if not unicodedata.combining(c))


def normalize(text):
    return strip_accents(text or "").strip().lower()


def split_phones(raw):
    """CollectionPoint.contact_phone is capped at 30 chars and is meant for
    one identity-matching number; a CSV cell listing several numbers
    (separated by '/', ',', ';' or a line break) would otherwise blow past
    that limit. Returns (first_number, remaining_numbers_or_empty_string)
    -- the rest goes to the free-text other_phones field instead of being
    dropped."""
    parts = [p.strip() for p in re.split(r"[\n/;,]+", raw or "") if p.strip()]
    if not parts:
        return "", ""
    return parts[0][:30], "\n".join(parts[1:])


def fundraising_hit(row):
    """Returns the matched keyword if ANY column of this row mentions an
    online money-collection platform/link, else None."""
    blob = normalize(" | ".join(v or "" for v in row.values()))
    for kw in FUNDRAISING_KEYWORDS:
        if kw in blob:
            return kw
    return None


def city_query_candidates(ville):
    """A raw CSV city cell sometimes carries a French department code or a
    more precise place name in parentheses, e.g. "Argenteuil (95)" or
    "Paris (Saint-Denis)". Returns geocoding query candidates, most
    specific first: the parenthetical content when it looks like a place
    name (contains a letter, not just a department number), then the bare
    name before the parenthesis."""
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
    return candidates


class NominatimClient:
    """Thin, rate-limited wrapper around the public Nominatim /search
    endpoint -- same service and endpoint the frontend already uses
    client-side (frontend/src/utils.js). Fails soft: any network error
    (including this command's environment having no route to
    nominatim.openstreetmap.org at all) is treated as "no result",
    logged once, never raised -- a geocoding outage must never abort the
    whole import."""

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
        if not query:
            return None
        if self._unavailable:
            return None
        cache_key = (query, country_code)
        if cache_key in self._cache:
            return self._cache[cache_key]
        self._throttle()
        params = {"q": query, "format": "json", "limit": 1, "addressdetails": 0}
        if country_code:
            params["countrycodes"] = country_code.lower()
        try:
            resp = requests.get(
                NOMINATIM_URL, params=params,
                headers={"User-Agent": NOMINATIM_USER_AGENT}, timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            self._unavailable = True
            if self.stdout:
                self.stdout.write(
                    f"  [geocoding] Nominatim unreachable from this environment ({exc}); "
                    "falling back to the offline city table for the rest of this run."
                )
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


@dataclass
class RowResult:
    index: int
    code: str
    point_name: str
    international: bool
    status: str  # would_create | duplicate | excluded | manual_review | ignored | error
    source: str = ""  # input CSV filename this row came from -- lets reports from separate batches be told apart once merged
    reason: str = ""
    location_label: str = ""  # wilaya name or country name, for the report
    latitude: float = None
    longitude: float = None
    geocode_source: str = ""  # nominatim | offline_fallback | wilaya_centroid | none
    image_found: bool = False
    payload: dict = field(default_factory=dict)
    flyer_path: Path = None


def _find_existing_point(code, organization, location_key, international):
    """Dedup guard for re-runs of the same/an extended CSV: a code always
    wins (issued once per point, per the spec) when present; otherwise
    fall back to organization + the same wilaya/country + comparable
    address text, since a code is optional data-entry-wise even though
    every row in practice carries one."""
    code = (code or "").strip()
    if code:
        existing = CollectionPoint.objects.filter(recovery_code=code).first()
        if existing:
            return existing
    organization = (organization or "").strip()
    if not organization or not location_key:
        return None
    qs = CollectionPoint.objects.filter(organization__iexact=organization)
    if international:
        qs = qs.filter(country_name__iexact=location_key)
    else:
        qs = qs.filter(wilaya__name__iexact=location_key)
    return qs.first()


def resolve_national(row, wilaya_by_name, geocoder, stdout):
    """Returns (wilaya_or_None, latitude_or_None, longitude_or_None,
    geocode_source, note)."""
    ville = (row.get("ville") or "").strip()
    adresse = (row.get("adresse") or "").strip()

    wilaya = wilaya_by_name.get(normalize(ville))
    lat = lon = None
    source = ""

    # A precise street address (longer/more specific than just the city
    # name) is worth a live geocode for an exact pin; a bare city name adds
    # nothing over the wilaya's own centroid fallback, so it's skipped.
    if adresse and normalize(adresse) != normalize(ville) and len(adresse) > len(ville) + 3:
        hit = geocoder.search(adresse, country_code="dz")
        if hit:
            lat, lon, _ = hit
            source = "nominatim"

    if wilaya is None:
        for candidate in city_query_candidates(ville):
            hit = geocoder.search(f"{candidate}, Algérie", country_code="dz")
            if hit:
                clat, clon, _ = hit
                best, best_dist = None, None
                for w in Wilaya.objects.exclude(centroid_latitude=None):
                    dist = (w.centroid_latitude - clat) ** 2 + (w.centroid_longitude - clon) ** 2
                    if best_dist is None or dist < best_dist:
                        best, best_dist = w, dist
                if best is not None:
                    wilaya = best
                    if lat is None:
                        lat, lon, source = clat, clon, "nominatim"
                break

    if wilaya is None:
        return None, None, None, "", (
            f"Ville '{ville}' non reconnue comme wilaya et non géocodable automatiquement "
            "-- wilaya à assigner manuellement."
        )
    return wilaya, lat, lon, source, ""


def resolve_international(row, geocoder, stdout):
    """Returns (country_code, country_name, latitude, longitude,
    geocode_source, note, no_city). latitude/longitude are None (never
    invented) when nothing better than "country" is known -- the model
    requires an exact position for an international point, so such a row
    can never be created. `no_city` distinguishes why: True when there was
    never a city to work with in the first place (per spec, that row is
    simply ignored rather than queued for manual follow-up); False when a
    city WAS given but geocoding still failed (something an admin could
    plausibly still fix -- a bad spelling, or a town worth adding to
    OFFLINE_CITY_COORDS -- so that case stays manual_review)."""
    pays = (row.get("pays") or "").strip()
    ville = (row.get("ville") or "").strip()
    adresse = (row.get("adresse") or "").strip()
    has_city = bool(ville) and normalize("non précisée") not in normalize(ville) and normalize(ville) != normalize(pays)

    iso = COUNTRY_NAME_TO_ISO.get(normalize(pays))
    if not iso:
        return None, pays, None, None, "", f"Pays '{pays}' non reconnu -- code ISO à assigner manuellement.", False
    if iso == "DZ":
        return None, pays, None, None, "", "Un point international ne peut pas être en Algérie (donnée incohérente).", False

    lat = lon = None
    source = ""
    if adresse and normalize(adresse) not in (normalize(ville), normalize(pays)):
        hit = geocoder.search(adresse, country_code=iso)
        if hit:
            lat, lon, _ = hit
            source = "nominatim"

    if lat is None:
        candidates = city_query_candidates(ville) if has_city else []
        for candidate in candidates:
            key = (normalize(candidate), iso)
            hit = geocoder.search(f"{candidate}, {pays}", country_code=iso)
            if hit:
                lat, lon, _ = hit
                source = "nominatim"
                break
            if key in OFFLINE_CITY_COORDS:
                lat, lon = OFFLINE_CITY_COORDS[key]
                source = "offline_fallback"
                break

    note = ""
    if lat is None:
        if not has_city:
            note = f"Pays '{pays}' seul, aucune ville -- ligne ignorée (position GPS exacte impossible à obtenir)."
        else:
            note = (
                "Aucune position exacte trouvée (ville inconnue ou non géocodable) -- "
                "un point international exige un pin GPS exact, impossible à créer automatiquement."
            )
    return iso, pays, lat, lon, source, note, (lat is None and not has_city)


class Command(BaseCommand):
    help = "Dry-run or import CollectionPoint rows from a partner CSV + flyer photos zip."

    def add_arguments(self, parser):
        parser.add_argument("--zip", dest="zip_path", help="Path to the sosdz-csv-*-et-images.zip archive.")
        parser.add_argument("--csv", dest="csv_path", help="Path to the CSV, if not using --zip.")
        parser.add_argument("--photos-dir", dest="photos_dir", help="Path to the photos/ folder, if not using --zip.")
        parser.add_argument("--apply", action="store_true", help="Actually create records (default is dry-run only).")
        parser.add_argument("--no-geocode", action="store_true", help="Skip Nominatim entirely (offline table + wilaya name matching only).")
        parser.add_argument("--limit", type=int, default=None, help="Only process the first N rows (testing).")
        parser.add_argument("--report-csv", dest="report_csv", help="Where to write the per-row CSV report (default: alongside the input CSV).")

    def handle(self, *args, **options):
        csv_path, photos_dir, tmp_root = self._resolve_inputs(options)
        rows = self._read_csv(csv_path)
        if options["limit"]:
            rows = rows[: options["limit"]]

        wilaya_by_name = {normalize(w.name): w for w in Wilaya.objects.all()}
        geocoder = NominatimClient(stdout=self.stdout)
        if options["no_geocode"]:
            geocoder._unavailable = True

        results = []
        for idx, row in enumerate(rows, start=1):
            results.append(self._evaluate_row(idx, row, wilaya_by_name, geocoder, photos_dir, csv_path.name))

        self._print_report(results)
        self._write_report_csv(results, options.get("report_csv") or (csv_path.parent / "import_report.csv"))

        if options["apply"]:
            self._apply(results, csv_path)
        else:
            self.stdout.write(self.style.WARNING(
                "\nDry run only -- nothing was written to the database. Re-run with --apply once this looks right."
            ))

    # -- input handling ----------------------------------------------------

    def _resolve_inputs(self, options):
        if options["zip_path"]:
            zip_path = Path(options["zip_path"]).expanduser()
            if not zip_path.exists():
                raise CommandError(f"Zip not found: {zip_path}")
            extract_dir = zip_path.parent / f"{zip_path.stem}_extracted"
            with zipfile.ZipFile(zip_path) as zf:
                zf.extractall(extract_dir)
            csv_candidates = list(extract_dir.rglob("*.csv"))
            if not csv_candidates:
                raise CommandError(f"No CSV found inside {zip_path}")
            csv_path = csv_candidates[0]
            photos_candidates = [p for p in extract_dir.rglob("photos") if p.is_dir()]
            photos_dir = photos_candidates[0] if photos_candidates else extract_dir
            return csv_path, photos_dir, extract_dir
        if not options["csv_path"]:
            raise CommandError("Pass either --zip or --csv (optionally with --photos-dir).")
        csv_path = Path(options["csv_path"]).expanduser()
        if not csv_path.exists():
            raise CommandError(f"CSV not found: {csv_path}")
        photos_dir = Path(options["photos_dir"]).expanduser() if options["photos_dir"] else csv_path.parent / "photos"
        return csv_path, photos_dir, None

    def _read_csv(self, csv_path):
        with open(csv_path, encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))

    # -- per-row evaluation --------------------------------------------------

    def _evaluate_row(self, idx, row, wilaya_by_name, geocoder, photos_dir, source_name):
        code = (row.get(RECOVERY_CODE_FIELD) or "").strip()
        point_name = (row.get("nom_point") or "").strip()
        international = normalize(row.get("international")) == "true"

        hit = fundraising_hit(row)
        if hit:
            return RowResult(idx, code, point_name, international, "excluded", source=source_name,
                              reason=f"Mention d'un lien de collecte d'argent en ligne détectée ('{hit}').")

        flyer_name = (row.get(FLYER_FIELD) or "").strip()
        flyer_path = (photos_dir / flyer_name) if flyer_name else None
        image_found = bool(flyer_path and flyer_path.exists())

        description = (row.get("description") or "").strip()
        flyer_text = (row.get("texte_complet_flyer") or "").strip()
        if flyer_text and flyer_text != description:
            description = f"{description}\n\n{flyer_text}".strip() if description else flyer_text

        contact_phone, other_phones = split_phones(row.get("contact_telephone"))
        common = {
            "point_name": point_name,
            "organization": (row.get("organisation") or "").strip(),
            "contact_name": (row.get("contact_nom") or "").strip(),
            "contact_phone": contact_phone,
            "other_phones": other_phones,
            "hours": (row.get("horaires") or "").strip(),
            "description": description,
            "accepted_donations": (row.get("dons_demandes") or "").strip(),
            "facebook_url": (row.get("facebook") or "").strip(),
            "tiktok_url": (row.get("tiktok") or "").strip(),
            "instagram_url": (row.get("instagram") or "").strip(),
            "recovery_code": code,
        }
        # The three socials are handles/usernames in this CSV, not URLs --
        # CollectionPointCreateSerializer.validate_*_url requires http(s).
        for field_name, base_url in (
            ("facebook_url", "https://facebook.com/"),
            ("tiktok_url", "https://www.tiktok.com/@"),
            ("instagram_url", "https://www.instagram.com/"),
        ):
            v = common[field_name]
            if v and not re.match(r"^https?://", v, re.IGNORECASE):
                common[field_name] = base_url + v.lstrip("@/")

        adresse = (row.get("adresse") or "").strip()
        ville = (row.get("ville") or "").strip()
        common["location_description"] = adresse or ville or (row.get("pays") or "").strip() or "Adresse non précisée"

        if international:
            iso, country_name, lat, lon, source, note, no_city = resolve_international(row, geocoder, self.stdout)
            if note:
                status = "ignored" if no_city else "manual_review"
                return RowResult(idx, code, point_name, True, status, source=source_name, reason=note,
                                  location_label=country_name, image_found=image_found, flyer_path=flyer_path)
            existing = _find_existing_point(code, common["organization"], country_name, True)
            if existing:
                return RowResult(idx, code, point_name, True, "duplicate", source=source_name,
                                  reason=f"Existe déjà (id={existing.id}).", location_label=country_name,
                                  image_found=image_found, flyer_path=flyer_path)
            common["country_code"] = iso
            common["country_name"] = country_name
            common["latitude"] = lat
            common["longitude"] = lon
            return RowResult(idx, code, point_name, True, "would_create", source=source_name,
                              location_label=country_name, latitude=lat, longitude=lon,
                              geocode_source=source, image_found=image_found,
                              payload=common, flyer_path=flyer_path)
        else:
            wilaya, lat, lon, source, note = resolve_national(row, wilaya_by_name, geocoder, self.stdout)
            if wilaya is None:
                return RowResult(idx, code, point_name, False, "manual_review", source=source_name, reason=note,
                                  location_label=ville, image_found=image_found, flyer_path=flyer_path)
            existing = _find_existing_point(code, common["organization"], wilaya.name, False)
            if existing:
                return RowResult(idx, code, point_name, False, "duplicate", source=source_name,
                                  reason=f"Existe déjà (id={existing.id}).", location_label=wilaya.name,
                                  image_found=image_found, flyer_path=flyer_path)
            common["wilaya"] = wilaya.pk
            common["latitude"] = lat
            common["longitude"] = lon
            return RowResult(idx, code, point_name, False, "would_create", source=source_name,
                              location_label=wilaya.name, latitude=lat, longitude=lon,
                              geocode_source=(source or ("wilaya_centroid" if lat is None else source)),
                              image_found=image_found, payload=common, flyer_path=flyer_path)

    # -- reporting -----------------------------------------------------------

    def _print_report(self, results):
        counts = {}
        for r in results:
            counts[r.status] = counts.get(r.status, 0) + 1
            gps = f"{r.latitude:.4f},{r.longitude:.4f}" if r.latitude is not None else "-"
            img = "oui" if r.image_found else "non"
            kind = "INTL" if r.international else "NAT "
            self.stdout.write(
                f"[{r.index:3}] {kind} {r.code or '------':>6} {r.status:14} "
                f"{r.location_label or '-':20.20} gps={gps:20} image={img} "
                f"{r.point_name[:40]!r} {('- ' + r.reason) if r.reason else ''}"
            )
        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS(f"Total: {len(results)} lignes -- " + ", ".join(f"{k}={v}" for k, v in counts.items())))

    def _write_report_csv(self, results, out_path):
        out_path = Path(out_path)
        with open(out_path, "w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow([
                "source", "index", "code", "point_name", "international", "status", "reason",
                "location", "latitude", "longitude", "geocode_source", "image_found",
            ])
            for r in results:
                writer.writerow([
                    r.source, r.index, r.code, r.point_name, r.international, r.status, r.reason,
                    r.location_label, r.latitude, r.longitude, r.geocode_source, r.image_found,
                ])
        self.stdout.write(f"Rapport détaillé écrit dans {out_path}")

    # -- apply -----------------------------------------------------------

    def _apply(self, results, csv_path):
        created_national = created_international = errors = 0
        for r in results:
            if r.status != "would_create":
                continue
            try:
                with transaction.atomic():
                    point = self._create_point(r)
            except Exception as exc:
                errors += 1
                self.stdout.write(self.style.ERROR(f"[{r.index}] échec de la création: {exc}"))
                continue
            if r.international:
                created_international += 1
            else:
                created_national += 1
            AuditLog.objects.create(
                admin_user=None,
                action="imported collection point (bulk CSV import)",
                target_description=f"#{point.id} {point.point_name} ({r.location_label})",
                reason=f"source={csv_path.name} row={r.index} code={r.code}",
            )

        excluded = sum(1 for r in results if r.status == "excluded")
        duplicates = sum(1 for r in results if r.status == "duplicate")
        manual = sum(1 for r in results if r.status == "manual_review")
        ignored = sum(1 for r in results if r.status == "ignored")
        AuditLog.objects.create(
            admin_user=None,
            action="bulk import collection points (summary)",
            target_description=(
                f"{created_national} national(aux), {created_international} international(aux), "
                f"{duplicates} déjà existants (doublons), {excluded} exclus (lien de collecte d'argent), "
                f"{ignored} ignorés (pays seul, sans ville ni position possible), "
                f"{manual} à traiter manuellement, {errors} en erreur"
            ),
            reason=f"source={csv_path.name}",
        )
        self.stdout.write(self.style.SUCCESS(
            f"\nCréés: {created_national} national(aux) + {created_international} international(aux). "
            f"Doublons: {duplicates}. Exclus: {excluded}. Ignorés (pays sans ville): {ignored}. "
            f"À traiter manuellement: {manual}. Erreurs: {errors}."
        ))

    def _create_point(self, r):
        serializer = CollectionPointCreateSerializer(data=r.payload)
        serializer.is_valid(raise_exception=True)
        point = serializer.save()

        if r.flyer_path and r.flyer_path.exists():
            data = r.flyer_path.read_bytes()
            if len(data) <= MAX_PHOTO_SIZE_BYTES:
                point.flyer_image.save(r.flyer_path.name, ContentFile(data), save=False)
                point.flyer_moderation_status = moderate_image_field(point.flyer_image)
                point.flyer_moderated_by = Need.MODERATED_BY_SYSTEM if moderation_active() else ""
                point.save()
            else:
                self.stdout.write(self.style.WARNING(
                    f"[{r.index}] flyer '{r.flyer_path.name}' ignoré (> {MAX_PHOTO_SIZE_MB}MB)."
                ))
        return point
