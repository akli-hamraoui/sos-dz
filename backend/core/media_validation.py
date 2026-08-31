"""Server-side media validation for Wave 2: max 3 photos per listing, and a
best-effort video duration cap. Client-side compression (photos resized to
~1280px/JPEG ~70%, video auto-stopped at 20s) is the primary control, per
spec -- this is the server-side backstop.

Video duration is checked "if duration metadata is available" (spec's own
wording): it needs `ffprobe` on PATH, which isn't installed in this sandbox
and isn't guaranteed on every deployment target either. When it's missing,
the check is skipped rather than blocking uploads -- consistent with how
this project treats every other optional external dependency (MaxMind R2,
Turnstile): degrade gracefully, don't fail closed on an infra gap. Document
installing ffmpeg on the IONOS VPS in DEPLOYMENT.md if stricter enforcement
is wanted in production.
"""

import json
import logging
import shutil
import subprocess
import tempfile

from rest_framework import serializers

logger = logging.getLogger(__name__)

MAX_PHOTOS = 3
MAX_VIDEO_SECONDS = 20


def validate_photo_count(files):
    if len(files) > MAX_PHOTOS:
        raise serializers.ValidationError(f"Maximum {MAX_PHOTOS} photos allowed.")


def ffprobe_available():
    return shutil.which("ffprobe") is not None


def get_video_duration_seconds(django_file):
    """Returns a float duration, or None if it can't be determined (no
    ffprobe, or the file isn't a readable video)."""
    if not ffprobe_available():
        return None
    try:
        with tempfile.NamedTemporaryFile(suffix=".tmp") as tmp:
            for chunk in django_file.chunks():
                tmp.write(chunk)
            tmp.flush()
            django_file.seek(0)
            result = subprocess.run(
                [
                    "ffprobe", "-v", "error", "-show_entries", "format=duration",
                    "-of", "json", tmp.name,
                ],
                capture_output=True, text=True, timeout=10,
            )
            data = json.loads(result.stdout or "{}")
            return float(data["format"]["duration"])
    except Exception:
        logger.warning("Could not determine video duration server-side", exc_info=True)
        return None


def validate_video_duration(django_file):
    duration = get_video_duration_seconds(django_file)
    if duration is not None and duration > MAX_VIDEO_SECONDS:
        raise serializers.ValidationError(
            f"Video is {duration:.0f}s long, the maximum is {MAX_VIDEO_SECONDS}s."
        )
