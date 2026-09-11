"""Server-side write-time checks shared by creation/edit endpoints.

The guided voice SOS has its own Algeria-only location check. GPS coordinates
are accepted when they are inside Algeria. When GPS is unavailable, the server
uses the request IP as the authoritative fallback; the browser-side
BigDataCloud result is never trusted for authorization.
"""

import logging

from core.geoip import is_algeria_ip
from core.models import AppConfiguration
from core.validators import is_within_algeria_bounds

logger = logging.getLogger(__name__)

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
    """Validate the dedicated voice SOS location.

    A real GPS fix inside Algeria is accepted directly. Without GPS, use the
    server-side IP geolocation as the authoritative fallback. We deliberately
    do not trust the client-supplied BigDataCloud country code because it can
    be modified by a caller.
    """
    try:
        latitude = float(request.data.get("latitude"))
        longitude = float(request.data.get("longitude"))
    except (TypeError, ValueError):
        latitude = longitude = None

    if is_within_algeria_bounds(latitude, longitude):
        logger.info("[SOS] GPS reçu : latitude=%s longitude=%s", latitude, longitude)
        logger.info("[SOS] Résultat géographique : GPS confirmé en Algérie")
        return True

    logger.info("[SOS] GPS absent/invalide ; vérification géographique par IP")
    try:
        # Local import avoids the module-level circular import: views imports
        # write_guard from this module. It also preserves the existing test seam.
        from core.views import is_algeria_ip as view_is_algeria_ip

        allowed = view_is_algeria_ip(getattr(request, "client_ip", None))
    except (ImportError, AttributeError):
        allowed = is_algeria_ip(getattr(request, "client_ip", None))
    logger.info("[SOS] Résultat géographique : IP=%s autorisée=%s", getattr(request, "client_ip", None), allowed)
    return allowed is True


def geo_restriction_block(request):
    """Returns an error message if a write is blocked by geo restriction.

    Administrators bypass geo restriction. The dedicated voice SOS is always
    Algeria-only for non-admin users, independently of the site-wide toggle.
    """
    if is_request_admin(request):
        logger.info("[SOS] Vérification géographique : administrateur autorisé") if request.path.rstrip("/").endswith("/needs/voice-guide") else None
        return None

    if request.path.rstrip("/").endswith("/needs/voice-guide"):
        logger.info("[SOS] Début création SOS vocal - vérification géographique")
        if _voice_sos_location_allowed(request):
            logger.info("[SOS] Vérification géographique validée")
            return None
        logger.warning("[SOS] Création refusée - motif : localisation non autorisée")
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
