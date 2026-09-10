import time

from django.core.management.base import BaseCommand

from core.models import Need
from core.voice_ai import process_voice_need


class Command(BaseCommand):
    help = "Process pending guided voice SOS recordings with Whisper and the local LLM."

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

            if options["once"]:
                return

            time.sleep(interval)
