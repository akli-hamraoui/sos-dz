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


RECOVERY_CODE_MIN_LENGTH = 6


def check_recovery_code_available(model, value):
    """Validates an IdentityListingMixin.recovery_code at creation time: an
    empty code always passes (it just means "no code set", the name+phone
    fallback still works), but a chosen code must be long enough to resist
    guessing and must not already be in use by another listing of the same
    model -- two different people picking the same short code would
    otherwise both be able to "recover" whichever one guesses right first.
    Uniqueness is checked per model (Need vs Pickup) since recovery is
    always looked up against one specific listing's id, never a bare code
    alone, so only same-model collisions are meaningful."""
    value = (value or "").strip()
    if not value:
        return value
    if len(value) < RECOVERY_CODE_MIN_LENGTH:
        raise serializers.ValidationError(
            f"The recovery code must be at least {RECOVERY_CODE_MIN_LENGTH} characters long."
        )
    if model.objects.filter(recovery_code=value).exists():
        raise serializers.ValidationError(
            "This recovery code is already in use. Please choose a different one."
        )
    return value
