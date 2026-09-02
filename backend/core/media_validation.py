"""Server-side media validation for Wave 2: max 3 photos per listing, and an
optional server-enforced video duration cap. Client-side compression
(photos resized to ~1280px/JPEG ~70%, video auto-stopped at 20s) is the
primary control, per spec -- the server-side backstop below is a stricter
guarantee on top of that, not the only line of defense.

Video duration requires `ffprobe` on PATH. Unlike the other optional
external dependencies (MaxMind, R2, Turnstile), when this check is turned
on (AppConfiguration.enforce_video_duration_check, off by default -- see
Django Admin) it does not degrade gracefully: if duration can't be
determined, the video is rejected rather than silently accepted, since
accepting it would mean the 20s cap is unenforced server-side despite the
setting saying it should be. Off by default so a server without ffmpeg
installed doesn't reject every video submission outright; install ffmpeg
(see DEPLOYMENT.md step 1) and enable the setting for the server-side cap
to actually be enforced.
"""

import json
import logging
import shutil
import subprocess
import tempfile

from rest_framework import serializers

from core.models import AppConfiguration

logger = logging.getLogger(__name__)

MAX_PHOTOS = 3
MAX_VIDEO_SECONDS = 20
# Voice deliberately has no size cap here -- short spoken messages are
# small regardless, and the shared 30MB request-body ceiling
# (config.settings.DATA_UPLOAD_MAX_MEMORY_SIZE, matched by Nginx's
# client_max_body_size) is the only limit that applies to it.
MAX_PHOTO_SIZE_MB = 10
MAX_VIDEO_SIZE_MB = 10
MAX_PHOTO_SIZE_BYTES = MAX_PHOTO_SIZE_MB * 1024 * 1024
MAX_VIDEO_SIZE_BYTES = MAX_VIDEO_SIZE_MB * 1024 * 1024


def validate_photo_count(files):
    if len(files) > MAX_PHOTOS:
        raise serializers.ValidationError(f"Maximum {MAX_PHOTOS} photos allowed.")


def validate_photo_size(files):
    for f in files:
        if f.size > MAX_PHOTO_SIZE_BYTES:
            raise serializers.ValidationError(f"Photo exceeds the maximum size of {MAX_PHOTO_SIZE_MB}MB.")


def validate_video_size(django_file):
    if django_file.size > MAX_VIDEO_SIZE_BYTES:
        raise serializers.ValidationError(f"Video exceeds the maximum size of {MAX_VIDEO_SIZE_MB}MB.")


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
    if not AppConfiguration.get_solo().enforce_video_duration_check:
        return
    duration = get_video_duration_seconds(django_file)
    if duration is None:
        raise serializers.ValidationError(
            "Video duration could not be verified server-side, so it can't be "
            "accepted. Please try again, or contact support if this persists."
        )
    if duration > MAX_VIDEO_SECONDS:
        raise serializers.ValidationError(
            f"Video is {duration:.0f}s long, the maximum is {MAX_VIDEO_SECONDS}s."
        )
