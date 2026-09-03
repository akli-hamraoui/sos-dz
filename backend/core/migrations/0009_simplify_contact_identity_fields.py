# Simplifies the contact/responder identity fields collected for the
# recover-access flow: merges last_name+first_name into a single free-text
# name field, and drops date_of_birth entirely (name+phone is now the whole
# identity check -- see Need/Pickup.matches_identity). No real deployment
# exists yet (see DEPLOYMENT.md), so there's no production data to
# migrate/preserve here.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0008_need_split_voice_video_media"),
    ]

    operations = [
        migrations.RemoveField(
            model_name="need",
            name="contact_first_name",
        ),
        migrations.RemoveField(
            model_name="need",
            name="contact_last_name",
        ),
        migrations.RemoveField(
            model_name="need",
            name="contact_date_of_birth",
        ),
        migrations.AddField(
            model_name="need",
            name="contact_name",
            field=models.CharField(default="", max_length=200),
            preserve_default=False,
        ),
        migrations.RemoveField(
            model_name="pickup",
            name="responder_first_name",
        ),
        migrations.RemoveField(
            model_name="pickup",
            name="responder_last_name",
        ),
        migrations.RemoveField(
            model_name="pickup",
            name="responder_date_of_birth",
        ),
        migrations.AddField(
            model_name="pickup",
            name="responder_name",
            field=models.CharField(default="", max_length=200),
            preserve_default=False,
        ),
    ]
