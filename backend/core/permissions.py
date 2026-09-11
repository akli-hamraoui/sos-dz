"""Server-side write-time checks shared by creation/edit endpoints.

The guided voice SOS has its own Algeria-only location check. It deliberately
uses the location information supplied by that flow (GPS when available, or
the browser's BigDataCloud country fallback when GPS is unavailable) and does
not depend on the GeoLite2 database.
"""

from core.geoip import is_algeria_ip
from core.models import AppConfiguration
from core.validators import is_within_algeria_bounds


VOICE_SOS_GEO_MESSAGE = "Cette fonctionnalité est uniquement disponible en Algérie."


def is_request_admin(request):
    user = getattr(request, "user", None)
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


def read_only_block(request):
    """Returns an error message if global read-only mode blocks writes."""
    config = AppConfiguration.get_solo()
    if config.mode == AppConfiguration.MODE_READ_ONLY:
        return "The app is currently in read-only mode. Existing data remains viewable."
    return None


def _voice_sos_location_allowed(request):
    """Validate the dedicated voice SOS location without GeoLite2.

    GPS coordinates are preferred and checked against Algeria's geographic
    bounds. If GPS was not available, the browser may provide the country
    returned by BigDataCloud's client-side IP fallback. This value is used
    only for this dedicated voice-SOS flow.
    """
    try:
        latitude = float(request.data.get("latitude"))
        longitude = float(request.data.get("longitude"))
    except (TypeError, ValueError):
        latitude = longitude = None

    if is_within_algeria_bounds(latitude, longitude):
        return True

    country_code = str(request.data.get("location_country_code") or "").strip().upper()
    return country_code == "DZ"


def geo_restriction_block(request):
    """Returns an error message if a write is blocked by geo restriction.

    Administrators bypass geo restriction. The dedicated voice SOS does not
    use the server GeoLite2/IP check: it relies on GPS, with the browser-side
    BigDataCloud country fallback when GPS is unavailable.
    """
    if is_request_admin(request):
        return None

    # The voice SOS has a dedicated location policy. Keep it independent from
    # the site-wide GeoLite2 setting/database.
    if request.path.rstrip("/").endswith("/needs/voice-guide"):
        if _voice_sos_location_allowed(request):
            return None
        return VOICE_SOS_GEO_MESSAGE

    config = AppConfiguration.get_solo()
    if not config.geo_restrict_writes_to_algeria:
        return None

    allowed = is_algeria_ip(getattr(request, "client_ip", None))
    if allowed is True:
        return None

    return (
        "Only visible from within Algeria can create or edit listings — "
        "you can still browse everything."
    )


def write_guard(request):
    """Returns an error message if this write should be blocked, else None."""
    return read_only_block(request) or geo_restriction_block(request)
