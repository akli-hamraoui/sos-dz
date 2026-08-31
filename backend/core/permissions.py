"""Server-side write-time checks shared by all creation/edit endpoints:
global read-only mode and the Algeria IP write restriction. Both are
enforced here (never only in the frontend) and both must be checked on
every creation/edit attempt.
"""

from core.geoip import is_algeria_ip
from core.models import AppConfiguration


def is_request_admin(request):
    user = getattr(request, "user", None)
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


def read_only_block(request):
    """Returns an error message if global read-only mode blocks writes,
    else None. Admins are NOT exempt from read-only mode (unlike the geo
    restriction) -- read-only mode is a full stop requested by an authority."""
    config = AppConfiguration.get_solo()
    if config.mode == AppConfiguration.MODE_READ_ONLY:
        return "The app is currently in read-only mode. Existing data remains viewable."
    return None


def geo_restriction_block(request):
    """Returns an error message if the Algeria IP write restriction blocks
    this request, else None. Admins always bypass this check, from anywhere."""
    if is_request_admin(request):
        return None
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
    """Returns an error message (string) if this write should be blocked,
    or None if it's allowed. Checks read-only mode first, then geo-restriction."""
    return read_only_block(request) or geo_restriction_block(request)
