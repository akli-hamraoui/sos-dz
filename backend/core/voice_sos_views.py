import logging

from rest_framework import status

from core.validators import is_within_algeria_bounds
from core.views import NeedViewSet

logger = logging.getLogger(__name__)


class VoiceSOSNeedViewSet(NeedViewSet):
    """Keep the existing NeedViewSet behavior while making a real GPS fix
    sufficient for the voice-SOS Algeria gate.

    The existing action performs an IP-only pre-check before calling
    ``create()``. That pre-check incorrectly rejects a valid Algerian GPS fix
    when server-side IP geolocation is unavailable (for example, GeoLite2 is
    missing). The inherited ``create()`` still runs the authoritative
    ``write_guard`` check, which validates the GPS coordinates and keeps the
    server-side policy intact.
    """

    def _voice_feature_allowed(self, request):
        try:
            latitude = float(request.data.get("latitude"))
            longitude = float(request.data.get("longitude"))
        except (TypeError, ValueError):
            latitude = longitude = None

        if is_within_algeria_bounds(latitude, longitude):
            logger.info("[SOS] Pré-contrôle vocal : GPS en Algérie, IP non requise")
            return True

        return super()._voice_feature_allowed(request)

    def create(self, request, *args, **kwargs):
        response = super().create(request, *args, **kwargs)
        if request.path.rstrip("/").endswith("/needs/voice-guide"):
            if response.status_code == status.HTTP_201_CREATED:
                logger.info("[SOS] SOS créé : id=%s", response.data.get("id"))
            elif response.status_code == status.HTTP_403_FORBIDDEN:
                logger.warning("[SOS] Création refusée : %s", response.data.get("detail"))
        return response
