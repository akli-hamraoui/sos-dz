import logging
import os
import time

import requests
from django.conf import settings
from django.core.management.base import BaseCommand

from core.models import Need, Signalement
from core.moderation import ffmpeg_available, moderation_active
from core.signalements import process_signalement, public_signalements, retry_unanswered_moderation
from core.voice_ai import process_voice_need

logger = logging.getLogger("core.worker")

# While idle, log a short "still alive" line this often so journalctl shows
# the worker is running even when there's nothing to process.
HEARTBEAT_SECONDS = 300
# While idle, re-check Signali photos/videos the moderation sidecar
# couldn't answer for (it was down) this often.
MODERATION_RETRY_SECONDS = 120


def _sidecar_status():
    """'ok' / 'unreachable (...)' for the NSFW moderation sidecar."""
    try:
        requests.get(settings.NSFWJS_SIDECAR_URL, timeout=3)
        return "ok"
    except Exception as exc:
        return f"unreachable ({exc.__class__.__name__})"


def _queue_counts():
    return {
        "voice_sos_pending": Need.objects.filter(voice_processing_status=Need.VOICE_PROCESSING_PENDING, is_cancelled=False).count(),
        "signali_pending": Signalement.objects.filter(processing_status=Signalement.PROCESSING_PENDING).count(),
    }


class Command(BaseCommand):
    help = (
        "Process pending guided voice SOS recordings with Whisper and the local LLM, "
        "and pending Signali reports (NSFW moderation, transcription, geocoding). "
        "--status prints a diagnostic and exits."
    )

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Process available jobs once and exit.")
        parser.add_argument("--interval", type=float, default=2.0, help="Polling interval in seconds.")
        parser.add_argument("--status", action="store_true", help="Print queue/moderation diagnostics and exit.")

    def _log(self, message, *args):
        text = message % args if args else message
        logger.info(text)

    def status(self):
        """One-shot diagnostic: is there a backlog, is moderation reachable,
        and why the latest reports are (not) on the public map."""
        counts = _queue_counts()
        self.stdout.write(f"Pending voice SOS: {counts['voice_sos_pending']}")
        self.stdout.write(f"Pending Signali reports: {counts['signali_pending']}")
        self.stdout.write(
            f"Media moderation active: {moderation_active()} | sidecar {settings.NSFWJS_SIDECAR_URL}: {_sidecar_status()}"
            f" | ffmpeg (video frames): {'yes' if ffmpeg_available() else 'NOT INSTALLED'}"
        )
        public_ids = set(public_signalements().values_list("pk", flat=True))
        self.stdout.write("Latest Signali reports:")
        for s in Signalement.objects.order_by("-pk").prefetch_related("photos")[:10]:
            photos = [p.moderation_status for p in s.photos.all()]
            video = s.video_moderation_status if s.video_file else "-"
            if s.status == Signalement.STATUS_CANCELLED:
                why = "hidden: cancelled"
            elif s.pk not in public_ids:
                why = "hidden: all its media rejected, or flagged as abusive"
            else:
                why = "ON THE MAP"
                unchecked = [p for p in s.photos.all() if p.moderation_status == "pending" and not p.moderated_by]
                doubt = [p for p in s.photos.all() if p.moderation_status == "pending" and p.moderated_by]
                if unchecked or (s.video_file and s.video_moderation_status == "pending" and not s.video_moderated_by):
                    why += " (some media not checked yet: sidecar/ffmpeg unavailable, the worker retries)"
                elif doubt or (s.video_file and s.video_moderation_status == "pending"):
                    why += " (some media in doubt: approve/reject it in Django Admin)"
            self.stdout.write(
                f"  #{s.pk} {s.created_at:%Y-%m-%d %H:%M} {s.wilaya} processing={s.processing_status} "
                f"photos={photos} video={video} gps={'yes' if s.latitude is not None else 'no'} -> {why}"
                + (f" | errors: {s.processing_error}" if s.processing_error else "")
            )

    def handle(self, *args, **options):
        if options["status"]:
            return self.status()

        interval = max(0.5, options["interval"])
        counts = _queue_counts()
        self._log(
            "Worker started: pid=%s interval=%ss moderation_active=%s sidecar=%s whisper_model=%s llm=%s pending=%s",
            os.getpid(), interval, moderation_active(), _sidecar_status(),
            getattr(settings, "VOICE_WHISPER_MODEL", "small"), getattr(settings, "VOICE_LLM_MODEL", "?"), counts,
        )
        last_beat = time.monotonic()
        last_retry = 0.0
        while True:
            need = (
                Need.objects
                .filter(
                    voice_processing_status=Need.VOICE_PROCESSING_PENDING,
                    is_cancelled=False,
                )
                .order_by("created_at")
                .first()
            )
            if need:
                self._run(f"voice SOS #{need.pk}", process_voice_need, need.pk)
                last_beat = time.monotonic()
                continue

            # Urgent SOS first: a Signali report can wait a few seconds more.
            signalement = (
                Signalement.objects
                .filter(processing_status=Signalement.PROCESSING_PENDING)
                .order_by("created_at")
                .first()
            )
            if signalement:
                self._run(f"Signali report #{signalement.pk}", process_signalement, signalement.pk)
                last_beat = time.monotonic()
                continue

            if time.monotonic() - last_retry >= MODERATION_RETRY_SECONDS or options["once"]:
                last_retry = time.monotonic()
                try:
                    retry_unanswered_moderation()
                except Exception:
                    logger.exception("Worker: moderation retry crashed")

            if options["once"]:
                self._log("Worker: queue empty, exiting (--once).")
                return

            if time.monotonic() - last_beat >= HEARTBEAT_SECONDS:
                self._log("Worker alive: queue empty, %s", _queue_counts())
                last_beat = time.monotonic()
            time.sleep(interval)

    def _run(self, label, func, pk):
        """Runs one job with start/end/duration logs. Never lets an
        unexpected error kill the loop (the job's own code already marks
        its record failed/ready)."""
        self._log("Worker: processing %s...", label)
        started = time.monotonic()
        try:
            func(pk)
        except Exception:
            logger.exception("Worker: %s crashed after %.1fs", label, time.monotonic() - started)
            # Don't spin on the same broken record forever.
            if label.startswith("Signali"):
                Signalement.objects.filter(pk=pk, processing_status=Signalement.PROCESSING_PENDING).update(
                    processing_status=Signalement.PROCESSING_READY, processing_error="Worker crash, see logs."
                )
            return
        self._log("Worker: done %s in %.1fs", label, time.monotonic() - started)
