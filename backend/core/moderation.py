"""Automatic photo/video moderation via NSFWJS (Wave 3): calls the local
sidecar in moderation-sidecar/ over HTTP (never a paid third-party API,
never a network call outside this server). See that directory's README
comment (server.js) for why it's a separate process rather than living
inside Django, and DEPLOYMENT.md for how it's run in production.

Design choice, stated explicitly because it differs from how this project
treats other *optional* external dependencies (R2, MaxMind, Turnstile):
when the sidecar is unreachable while moderation is supposed to be
active, media is queued for human review ("pending"), never silently
auto-approved. Those other integrations fail open (degrade gracefully to
"feature off") because being unreachable there just loses a convenience.
Here, failing open would mean unmoderated content going straight to
publication -- the one place in this project where "fail closed" is the
safer default.
"""

import logging
import shutil
import subprocess
import tempfile
from pathlib import Path

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

STATUS_APPROVED = "approved"
STATUS_PENDING = "pending"
STATUS_REJECTED = "rejected"

FRAME_INTERVAL_SECONDS = 4  # "every 3-5 seconds", per spec


class ModerationUnavailable(Exception):
    pass


def classify_image_bytes(data, filename="upload.jpg"):
    """Returns the combined unsafe score (float, 0-1) from the sidecar.
    Raises ModerationUnavailable if it can't be reached or errors."""
    try:
        resp = requests.post(
            f"{settings.NSFWJS_SIDECAR_URL}/classify",
            files={"image": (filename, data, "application/octet-stream")},
            timeout=20,
        )
        resp.raise_for_status()
        return resp.json()["score"]
    except Exception as exc:
        logger.warning("NSFWJS sidecar unavailable or errored: %s", exc)
        raise ModerationUnavailable(str(exc)) from exc


def status_for_score(score):
    if score >= settings.NSFWJS_REJECT_THRESHOLD:
        return STATUS_REJECTED
    if score <= settings.NSFWJS_APPROVE_THRESHOLD:
        return STATUS_APPROVED
    return STATUS_PENDING


def moderation_active():
    from core.models import AppConfiguration

    return AppConfiguration.get_solo().media_moderation_active


def moderate_image_field(django_file):
    """django_file: an ImageField/FileField file object. Returns one of
    STATUS_APPROVED/STATUS_PENDING/STATUS_REJECTED."""
    if not moderation_active():
        return STATUS_APPROVED
    try:
        django_file.seek(0)
        data = django_file.read()
        django_file.seek(0)
        score = classify_image_bytes(data, getattr(django_file, "name", "upload.jpg"))
    except ModerationUnavailable:
        return STATUS_PENDING
    return status_for_score(score)


def ffmpeg_available():
    return shutil.which("ffmpeg") is not None


def moderate_video_field(django_file):
    """Extracts frames every FRAME_INTERVAL_SECONDS and classifies each,
    taking the worst (max) score across frames. Needs `ffmpeg` on PATH --
    not installed in this sandbox, so this path degrades to STATUS_PENDING
    (never auto-approved sight-unseen) when it's unavailable, consistent
    with the "fail toward manual review" policy above. Install ffmpeg on
    the IONOS VPS (documented in DEPLOYMENT.md) for full enforcement."""
    if not moderation_active():
        return STATUS_APPROVED
    if not ffmpeg_available():
        logger.warning("ffmpeg not found -- cannot extract video frames for moderation; queuing for manual review.")
        return STATUS_PENDING

    django_file.seek(0)
    with tempfile.TemporaryDirectory() as tmpdir:
        video_path = Path(tmpdir) / "input.mp4"
        video_path.write_bytes(django_file.read())
        django_file.seek(0)
        frame_pattern = str(Path(tmpdir) / "frame_%03d.jpg")
        try:
            subprocess.run(
                [
                    "ffmpeg", "-i", str(video_path), "-vf", f"fps=1/{FRAME_INTERVAL_SECONDS}",
                    frame_pattern, "-hide_banner", "-loglevel", "error",
                ],
                check=True, timeout=30,
            )
        except Exception:
            logger.warning("ffmpeg frame extraction failed; queuing video for manual review.", exc_info=True)
            return STATUS_PENDING

        frames = sorted(Path(tmpdir).glob("frame_*.jpg"))
        if not frames:
            return STATUS_PENDING

        worst_score = 0.0
        for frame in frames:
            try:
                score = classify_image_bytes(frame.read_bytes(), frame.name)
            except ModerationUnavailable:
                return STATUS_PENDING
            worst_score = max(worst_score, score)

    return status_for_score(worst_score)
