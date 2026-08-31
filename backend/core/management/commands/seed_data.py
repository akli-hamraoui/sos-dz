from django.core.management.base import BaseCommand

from core.seed_data import seed


class Command(BaseCommand):
    help = "Seed the 58 wilayas of Algeria and the default 'Général' campaign. Idempotent."

    def handle(self, *args, **options):
        seed()
        self.stdout.write(self.style.SUCCESS("Seed data is up to date."))
