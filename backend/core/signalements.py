"""Background processing for Signali reports (core.models.Signalement).

A report is public as soon as it's submitted; its photos/video are
checked right away, inside the request, like the SOS ones
(moderate_signalement_media), and each one is only shown once approved.
The voice worker (management/commands/process_voice_sos.py), which
already keeps the Whisper model loaded, then finishes it:

1. NSFW moderation of any photo/video the sidecar couldn't answer for
   at submission time -- and, while idle, it keeps retrying those
   (retry_unanswered_moderation) until the sidecar is back. Only a real
   doubt from the model ("pending") waits for an admin.
2. Whisper transcription of the voice note and of the video's own
   soundtrack (faster-whisper decodes the audio track of a webm/mp4
   directly). A rejected video is never transcribed.
3. When the reporter left the category on "Autre", the local LLM
   (same Ollama as the voice SOS) picks one from the text, if it can.
4. A typed address with no map pin is geocoded (Nominatim), and kept
   only if it lands in the wilaya the reporter picked -- otherwise the
   report stays "no exact position" and the map shows it around its
   wilaya's centre.

Transcription failures (no speech, Whisper unavailable) never block the
report: the photo/video is the report, the words are a bonus.
"""

import json
import logging
import math
from datetime import timedelta

import requests
from django.conf import settings
from django.db.models import Exists, OuterRef, Q
from django.utils import timezone

from core.collection_point_geocoding import NominatimClient
from core.models import Need, Signalement, SignalementPhoto, Wilaya
from core.validators import is_within_algeria_bounds
from core.moderation import check_image_field, check_video_field, ffmpeg_available, moderation_active, sidecar_reachable
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
    """Reports any public list may return: not flagged as abusive by too
    many people, and not made only of rejected media (a report whose
    every photo/video was rejected by moderation stays hidden). Photos
    and a video still awaiting a check don't hide the report: the
    serializers hide just those files until they're approved."""
    qs = Signalement.objects.all() if qs is None else qs
    rejected = Need.MODERATION_REJECTED
    photos = SignalementPhoto.objects.filter(signalement=OuterRef("pk"))
    has_video = ~Q(video_file="") & Q(video_file__isnull=False)
    shown_video = has_video & ~Q(video_moderation_status=rejected)
    return qs.filter(abuse_reports_count__lt=Signalement.ABUSE_REPORTS_TO_HIDE).filter(
        Q(Exists(photos.exclude(moderation_status=rejected)))
        | shown_video
        | (~Q(Exists(photos)) & ~has_video)
    )


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
        status__in=Signalement.OPEN_STATUSES,
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


def geocode_address(signalement):
    """(lat, lon) for a typed address inside the report's own wilaya, or
    None. Never raises."""
    address = (signalement.address or "").strip()
    if not address:
        return None
    query = ", ".join(p for p in (address, (signalement.commune or "").strip(), signalement.wilaya.name, "Algérie") if p)
    try:
        hit = NominatimClient().search(query, country_code="dz")
    except Exception:
        logger.exception("Signalement %s geocoding failed", signalement.pk)
        return None
    if not hit:
        return None
    lat, lon = hit[0], hit[1]
    if not is_within_algeria_bounds(lat, lon):
        return None
    nearest = nearest_wilaya(lat, lon)
    if not nearest or nearest.pk != signalement.wilaya_id:
        return None
    return lat, lon


def _moderated_by():
    return Need.MODERATED_BY_SYSTEM if moderation_active() else ""


def moderate_signalement_media(signalement):
    """Runs the NSFW check on every photo/video not checked yet. An answer
    (approved / rejected / pending = the model has a doubt, an admin
    decides) is stored for good. No answer (sidecar down, ffmpeg
    missing) leaves the file unchecked (moderated_by empty) so the
    worker retries it later. Returns how many files are still unchecked."""
    sid = signalement.pk
    unanswered = 0
    for photo in signalement.photos.filter(moderation_status=Need.MODERATION_PENDING, moderated_by=""):
        status = check_image_field(photo.image)
        if status is None:
            unanswered += 1
            logger.warning("Signalement %s: photo %s moderation unavailable, will retry", sid, photo.pk)
            continue
        photo.moderation_status = status
        photo.moderated_by = _moderated_by()
        photo.save(update_fields=["moderation_status", "moderated_by"])
        logger.info("Signalement %s: photo %s moderation -> %s", sid, photo.pk, status)

    if (
        signalement.video_file
        and not signalement.video_moderated_by
        and signalement.video_moderation_status == Need.MODERATION_PENDING
    ):
        status = check_video_field(signalement.video_file)
        if status is None:
            unanswered += 1
            logger.warning("Signalement %s: video moderation unavailable, will retry", sid)
        else:
            signalement.video_moderation_status = status
            signalement.video_moderated_by = _moderated_by()
            Signalement.objects.filter(pk=sid).update(
                video_moderation_status=status, video_moderated_by=signalement.video_moderated_by
            )
            logger.info("Signalement %s: video moderation -> %s", sid, status)
    return unanswered


# Retry window for media the sidecar couldn't answer for: past it, the
# file just stays "pending" for an admin (Django Admin approve action).
MODERATION_RETRY_MAX_AGE = timedelta(days=7)


def retry_unanswered_moderation():
    """Called by the idle worker: re-checks photos/videos the sidecar
    couldn't answer for (moderated_by still empty). Does nothing while the
    sidecar is down. Returns (checked reports, files still unchecked)."""
    if not moderation_active() or not sidecar_reachable():
        return 0, 0
    since = timezone.now() - MODERATION_RETRY_MAX_AGE
    photo_ids = SignalementPhoto.objects.filter(
        moderation_status=Need.MODERATION_PENDING, moderated_by="", signalement__created_at__gte=since,
    ).values_list("signalement_id", flat=True)
    q = Q(pk__in=photo_ids)
    if ffmpeg_available():
        q |= Q(video_moderation_status=Need.MODERATION_PENDING, video_moderated_by="") & ~Q(video_file="") & Q(video_file__isnull=False)
    reports = Signalement.objects.filter(q, created_at__gte=since).exclude(status=Signalement.STATUS_CANCELLED)
    checked = left = 0
    for signalement in reports.order_by("created_at")[:20]:
        try:
            left += moderate_signalement_media(signalement)
        except Exception:
            logger.exception("Signalement %s: moderation retry failed", signalement.pk)
            left += 1
        checked += 1
    if checked:
        logger.info("Moderation retry: %s report(s) re-checked, %s file(s) still unchecked", checked, left)
    return checked, left


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
    sid = signalement.pk
    logger.info(
        "Signalement %s: start (wilaya=%s category=%s gps=%s photos=%s video=%s voice=%s)",
        sid, signalement.wilaya, signalement.category, signalement.latitude is not None,
        signalement.photos.count(), bool(signalement.video_file), bool(signalement.voice_file),
    )
    try:
        if signalement.latitude is None:
            coords = geocode_address(signalement)
            if coords:
                signalement.latitude, signalement.longitude = coords
                logger.info("Signalement %s: address geocoded -> %.5f, %.5f", sid, *coords)
            else:
                logger.info("Signalement %s: no position found for the address, shown at its wilaya centre", sid)

        # Normally already done at submission; this catches what the
        # sidecar couldn't answer for then.
        moderate_signalement_media(signalement)

        if signalement.voice_file:
            signalement.voice_transcript = _transcribe(signalement.voice_file, "voice", sid, errors)
            logger.info("Signalement %s: voice transcript %s chars", sid, len(signalement.voice_transcript))
        if signalement.video_file and signalement.video_moderation_status != Need.MODERATION_REJECTED:
            signalement.video_transcript = _transcribe(signalement.video_file, "video", sid, errors)
            logger.info("Signalement %s: video transcript %s chars", sid, len(signalement.video_transcript))

        text = "\n".join(t for t in (signalement.description, signalement.voice_transcript, signalement.video_transcript) if t.strip())
        if signalement.category == Signalement.CATEGORY_OTHER and text:
            category = classify_category(text)
            logger.info("Signalement %s: AI category -> %s", sid, category or "unavailable")
            if category and category != Signalement.CATEGORY_OTHER:
                signalement.category = category
                signalement.category_suggested_by_ai = True
    except Exception:
        errors.append("Unexpected processing error.")
        logger.exception("Unexpected signalement processing failure: id=%s", signalement_id)

    signalement.processing_status = Signalement.PROCESSING_READY
    signalement.processing_error = "; ".join(errors)[:500]
    signalement.save()
    public = public_signalements(Signalement.objects.filter(pk=sid)).exists()
    logger.info(
        "Signalement %s: done -> %s (video=%s photos=%s errors=%s)",
        sid,
        "ON THE MAP" if public else "HIDDEN (all its media rejected, or flagged as abusive)",
        signalement.video_moderation_status if signalement.video_file else "-",
        list(signalement.photos.values_list("moderation_status", flat=True)),
        signalement.processing_error or "-",
    )
    return signalement
