"""Creates the "Feux en Algérie" campaign, restricted to the wilayas
actually affected by the wildfires, and deactivates the old generic
"Général" campaign so it's the only active one -- the create-need form
locks the campaign selector to whichever campaign is active (see
CreateNeed.jsx), so there must be exactly one for that to make sense.

Wilaya list only reachable through this migration (not seed_data.py's
fixed reference list) because it's specific to this real-world event,
not a permanent property of the wilayas themselves -- an admin can
add/remove wilayas from the campaign at any time via Django Admin
(Campaign.authorized_wilayas is a plain many-to-many multi-select
there already), no code change needed for that.
"""

from django.db import migrations

FIRE_WILAYA_NAMES = [
    "Béjaïa",
    "Jijel",
    "Tizi Ouzou",
    "Skikda",
    "Sétif",
    "El Tarf",
    "Guelma",
    "Mila",
    "Annaba",
    "Tébessa",
    "Constantine",
    "Bouira",
    "Aïn Defla",
    "Boumerdès",
    "Tissemsilt",
    "Sidi Bel Abbès",
    "Saïda",
    "Mascara",
]

CAMPAIGN_NAME = "Feux en Algérie"


def create_wildfire_campaign(apps, schema_editor):
    Campaign = apps.get_model("core", "Campaign")
    DisasterType = apps.get_model("core", "DisasterType")
    Wilaya = apps.get_model("core", "Wilaya")

    disaster_type, _ = DisasterType.objects.get_or_create(name="Wildfire", defaults={"icon": "fire"})

    campaign, _ = Campaign.objects.get_or_create(
        campaign_name=CAMPAIGN_NAME,
        defaults={"disaster_type": disaster_type, "status": "active"},
    )
    if campaign.status != "active":
        campaign.status = "active"
        campaign.save(update_fields=["status"])

    wilayas = Wilaya.objects.filter(name__in=FIRE_WILAYA_NAMES)
    campaign.authorized_wilayas.set(wilayas)

    # Deactivate any other campaign so this is the only active one --
    # the create-need form locks its campaign selector to "the" active
    # campaign, which only makes sense if there's exactly one.
    Campaign.objects.exclude(pk=campaign.pk).update(status="paused")


def reverse(apps, schema_editor):
    Campaign = apps.get_model("core", "Campaign")
    Campaign.objects.filter(campaign_name=CAMPAIGN_NAME).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0006_alter_need_covered_quantity"),
    ]

    operations = [
        migrations.RunPython(create_wildfire_campaign, reverse),
    ]
