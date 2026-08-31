"""Algeria bounding-box validation for submitted GPS coordinates. This
validates the CONTENT of a location field (a Need's or CollectionPoint's
lat/long) -- distinct from core.permissions' IP-based write restriction,
which validates WHO is allowed to write based on where the request comes
from. Both apply independently.
"""

from django.conf import settings
from rest_framework import serializers


def validate_algeria_bounds(latitude, longitude):
    """Raises serializers.ValidationError if the pair falls outside Algeria.
    Callers should catch this and gracefully fall back to manual entry
    (wilaya + text description) rather than hard-failing the whole form."""
    if latitude is None or longitude is None:
        return
    box = settings.ALGERIA_BOUNDING_BOX
    if not (box["lat_min"] <= latitude <= box["lat_max"]) or not (
        box["lon_min"] <= longitude <= box["lon_max"]
    ):
        raise serializers.ValidationError(
            "These coordinates fall outside Algeria and were rejected. "
            "Please use the wilaya + description fields instead."
        )
