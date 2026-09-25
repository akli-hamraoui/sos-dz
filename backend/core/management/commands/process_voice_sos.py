import time

from django.core.management.base import BaseCommand

from core.models import Need, Signalement
from core.signalements import process_signalement
from core.voice_ai import process_voice_need


class Command(BaseCommand):
    help = (
        "Process pending guided voice SOS recordings with Whisper and the local LLM, "
        "and pending Signali reports (NSFW moderation + transcription)."
    )

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true", help="Process available jobs once and exit.")
        parser.add_argument("--interval", type=float, default=2.0, help="Polling interval in seconds.")

    def handle(self, *args, **options):
        interval = max(0.5, options["interval"])
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
                self.stdout.write(f"Processing guided voice SOS #{need.pk}...")
                process_voice_need(need.pk)
                continue

            # Urgent SOS first: a Signali report can wait a few seconds more.
            signalement = (
                Signalement.objects
                .filter(processing_status=Signalement.PROCESSING_PENDING)
                .order_by("created_at")
                .first()
            )
            if signalement:
                self.stdout.write(f"Processing Signali report #{signalement.pk}...")
                process_signalement(signalement.pk)
                continue

            if options["once"]:
                return

            time.sleep(interval)
