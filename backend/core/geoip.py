"""IP -> country resolution using a local, offline MaxMind GeoLite2-Country
database (see README.md "GeoIP setup" for how to obtain the free .mmdb
file -- it's not committed to the repo).

This backs the WRITE restriction only (core.permissions.write_allowed_for_request).
It is unrelated to the Algeria bounding-box check on submitted lat/long
coordinates (core.validators.validate_algeria_bounds) -- that one validates
the content of a Need/CollectionPoint, this one validates who is allowed to
write based on where the HTTP request came from. Both exist and are kept
distinct, per spec.
"""

import logging
from pathlib import Path

from django.conf import settings

logger = logging.getLogger(__name__)

_reader = None
_reader_load_attempted = False

_PRIVATE_PREFIXES = ("127.", "10.", "192.168.", "::1")


def _get_reader():
    global _reader, _reader_load_attempted
    if _reader_load_attempted:
        return _reader
    _reader_load_attempted = True
    db_path = Path(settings.GEOIP_DB_PATH)
    if not db_path.exists():
        logger.warning(
            "GeoLite2 database not found at %s -- writes will be treated as "
            "non-Algeria (and denied) while geo_restrict_writes_to_algeria is "
            "enabled, until the database is installed or the restriction is "
            "disabled in Django Admin. See README.md 'GeoIP setup'.",
            db_path,
        )
        return None
    try:
        import geoip2.database

        _reader = geoip2.database.Reader(str(db_path))
    except Exception:
        logger.exception("Failed to load GeoLite2 database at %s", db_path)
        _reader = None
    return _reader


def resolve_country_code(ip_address):
    """Returns an ISO-3166-1 alpha-2 country code, or None if it can't be
    resolved (missing DB, private/local IP, lookup failure)."""
    if not ip_address or any(ip_address.startswith(p) for p in _PRIVATE_PREFIXES):
        return None
    reader = _get_reader()
    if reader is None:
        return None
    try:
        response = reader.country(ip_address)
        return response.country.iso_code
    except Exception:
        return None


def is_algeria_ip(ip_address):
    """True/False if resolvable, None if unknown (DB missing, lookup failed,
    private IP)."""
    code = resolve_country_code(ip_address)
    if code is None:
        return None
    return code == "DZ"
