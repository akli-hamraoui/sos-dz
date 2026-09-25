"""Background processing for Signali reports (core.models.Signalement).

A report is saved as soon as it's submitted (PROCESSING_PENDING, hidden
from public lists) and finished here by the voice worker
(management/commands/process_voice_sos.py), which already keeps the
Whisper model loaded:

1. NSFW moderation of every photo and of the video (core.moderation) --
   done here rather than inside the request so a slow sidecar or a long
   ffmpeg frame extraction never delays the reporter's confirmation.
2. Whisper transcription of the voice note and of the video's own
   soundtrack (faster-whisper decodes the audio track of a webm/mp4
   directly). A rejected video is never transcribed.
3. When the reporter left the category on "Autre", the local LLM
   (same Ollama as the voice SOS) picks one from the text, if it can.

Transcription failures (no speech, Whisper unavailable) never block the
report: the photo/video is the report, the words are a bonus.
"""

import json
import logging
import math
from datetime import timedelta

import requests
from django.conf import settings
from django.db.models import Q
from django.utils import timezone

from core.models import Need, Signalement, Wilaya
from core.moderation import moderate_image_field, moderate_video_field, moderation_active
from core.voice_ai import VoiceAIError, transcribe_audio

logger = logging.getLogger(__name__)


def nearest_wilaya(latitude, longitude):
    """Same nearest-centroid lookup as WilayaViewSet.nearest."""
    best, best_dist = None, None
    for wilaya in Wilaya.objects.exclude(centroid_latitude=None):
        dist = (wilaya.centroid_latitude - latitude) ** 2 + (wilaya.centroid_longitude - longitude) ** 2
        if best_dist is None or dist < best_dist:
            best, best_dist = wilaya, dist
    return best


NEARBY_RADIUS_METERS = 100
NEARBY_MAX_AGE_DAYS = 90


def public_signalements(qs=None):
    """Reports the worker is done with that still show at least one
    approved photo/video -- the only ones any public list may return."""
    qs = Signalement.objects.all() if qs is None else qs
    approved = Need.MODERATION_APPROVED
    return qs.filter(processing_status=Signalement.PROCESSING_READY).filter(
        (Q(video_moderation_status=approved) & ~Q(video_file="")) | Q(photos__moderation_status=approved)
    ).distinct()


def _distance_meters(lat1, lon1, lat2, lon2):
    rlat1, rlat2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((rlat2 - rlat1) / 2) ** 2 + math.cos(rlat1) * math.cos(rlat2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 6371000 * 2 * math.asin(math.sqrt(a))


def find_nearby_signalements(latitude, longitude, category=None, radius=NEARBY_RADIUS_METERS):
    """Open, public reports within `radius` meters -- offered to the
    reporter as "already reported? confirm it instead" before a
    duplicate gets created. A bounding box narrows it in SQL first."""
    dlat = radius / 111000
    dlon = radius / (111000 * max(math.cos(math.radians(latitude)), 0.01))
    qs = public_signalements().filter(
        status=Signalement.STATUS_NEW,
        created_at__gte=timezone.now() - timedelta(days=NEARBY_MAX_AGE_DAYS),
        latitude__range=(latitude - dlat, latitude + dlat),
        longitude__range=(longitude - dlon, longitude + dlon),
    )
    if category:
        qs = qs.filter(category=category)
    hits = [(s, _distance_meters(latitude, longitude, s.latitude, s.longitude)) for s in qs.select_related("wilaya").prefetch_related("photos")]
    return [s for s, d in sorted(hits, key=lambda x: x[1]) if d <= radius]


CATEGORY_SCHEMA = {
    "type": "object",
    "properties": {"category": {"type": "string", "enum": [c for c, _ in Signalement.CATEGORY_CHOICES]}},
    "required": ["category"],
    "additionalProperties": False,
}


def classify_category(text):
    """Best effort: returns one of Signalement.CATEGORY_CHOICES, or None if
    the local LLM is unavailable or answers anything unexpected."""
    categories = "; ".join(f"{code} = {label}" for code, label in Signalement.CATEGORY_CHOICES)
    prompt = (
        "A citizen reports a problem in public space in Algeria (French, Arabic or Darija). "
        "Pick the single best category code. Answer 'other' when unsure. Return only JSON.\n"
        f"CATEGORIES: {categories}\n\nREPORT:\n{text}"
    )
    payload = {
        "model": getattr(settings, "VOICE_LLM_MODEL", "qwen2.5:3b"),
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "format": CATEGORY_SCHEMA,
        "options": {"temperature": 0},
    }
    try:
        response = requests.post(getattr(settings, "VOICE_LLM_URL", "http://127.0.0.1:11434/api/chat"), json=payload, timeout=60)
        response.raise_for_status()
        category = json.loads(response.json().get("message", {}).get("content", "") or "{}").get("category")
    except Exception as exc:
        logger.warning("Signalement category classification unavailable: %s", exc)
        return None
    return category if category in dict(Signalement.CATEGORY_CHOICES) else None


def _moderated_by():
    return Need.MODERATED_BY_SYSTEM if moderation_active() else ""


def _transcribe(field, label, signalement_id, errors):
    try:
        return transcribe_audio(field)
    except VoiceAIError as exc:
        errors.append(f"{label}: {exc}")
        logger.warning("Signalement %s transcription skipped: %s", signalement_id, exc)
    except Exception:
        errors.append(f"{label}: unexpected transcription error.")
        logger.exception("Unexpected signalement %s transcription error", signalement_id)
    return ""


def process_signalement(signalement_id):
    signalement = Signalement.objects.get(pk=signalement_id)
    if signalement.processing_status != Signalement.PROCESSING_PENDING:
        return signalement

    errors = []
    try:
        for photo in signalement.photos.filter(moderation_status=Need.MODERATION_PENDING, moderated_by=""):
            photo.moderation_status = moderate_image_field(photo.image)
            photo.moderated_by = _moderated_by()
            photo.save(update_fields=["moderation_status", "moderated_by"])

        if signalement.video_file and not signalement.video_moderated_by:
            signalement.video_moderation_status = moderate_video_field(signalement.video_file)
            signalement.video_moderated_by = _moderated_by()

        if signalement.voice_file:
            signalement.voice_transcript = _transcribe(signalement.voice_file, "voice", signalement.pk, errors)
        if signalement.video_file and signalement.video_moderation_status != Need.MODERATION_REJECTED:
            signalement.video_transcript = _transcribe(signalement.video_file, "video", signalement.pk, errors)

        text = "\n".join(t for t in (signalement.description, signalement.voice_transcript, signalement.video_transcript) if t.strip())
        if signalement.category == Signalement.CATEGORY_OTHER and text:
            category = classify_category(text)
            if category and category != Signalement.CATEGORY_OTHER:
                signalement.category = category
                signalement.category_suggested_by_ai = True
    except Exception:
        errors.append("Unexpected processing error.")
        logger.exception("Unexpected signalement processing failure: id=%s", signalement_id)

    signalement.processing_status = Signalement.PROCESSING_READY
    signalement.processing_error = "; ".join(errors)[:500]
    signalement.save()
    logger.info(
        "Signalement processed: id=%s video=%s photos=%s errors=%s",
        signalement.pk,
        signalement.video_moderation_status if signalement.video_file else "-",
        list(signalement.photos.values_list("moderation_status", flat=True)),
        signalement.processing_error or "-",
    )
    return signalement
