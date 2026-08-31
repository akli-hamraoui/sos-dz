from django.db import migrations

from core.seed_data import seed


def forwards(apps, schema_editor):
    seed(apps)


def backwards(apps, schema_editor):
    # Intentionally a no-op: reference data (wilayas, default campaign) is
    # safe to leave in place, and other data may already depend on it.
    pass


class Migration(migrations.Migration):
    dependencies = [("core", "0001_initial")]
    operations = [migrations.RunPython(forwards, backwards)]
