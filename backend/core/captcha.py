"""Cloudflare Turnstile verification for the Need/Pickup creation forms
(anti-abuse, on top of rate limiting). When no secret key is configured
(local dev, or before a real Cloudflare account is set up), verification
is skipped entirely -- same "fall back gracefully when credentials are
absent" pattern used for R2 and MaxMind elsewhere in this project.
"""

import urllib.request
import urllib.parse
import json
import logging

from django.conf import settings

logger = logging.getLogger(__name__)

VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def verify_turnstile(token, remote_ip=None):
    """Returns (ok: bool, error_message: str|None)."""
    if not settings.TURNSTILE_ENABLED:
        return True, None
    if not token:
        return False, "Please complete the anti-spam check before submitting."
    try:
        data = urllib.parse.urlencode(
            {"secret": settings.TURNSTILE_SECRET_KEY, "response": token, "remoteip": remote_ip or ""}
        ).encode()
        req = urllib.request.Request(VERIFY_URL, data=data, method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read().decode())
        if result.get("success"):
            return True, None
        return False, "Anti-spam check failed, please try again."
    except Exception:
        logger.exception("Turnstile verification request failed")
        return False, "Could not verify the anti-spam check right now, please try again."
