"""Reference seed data: the 58 wilayas of Algeria (fixed closed list) with
approximate centroid coordinates (used as the map fallback position for
listings with no precise GPS), plus the default "Général" campaign that
must exist from first install so the app is usable before any admin
action. Used by both the seeding data migration and the `seed_data`
management command (idempotent either way).
"""

WILAYAS = [
    ("01", "Adrar", 27.87, -0.29),
    ("02", "Chlef", 36.17, 1.33),
    ("03", "Laghouat", 33.80, 2.86),
    ("04", "Oum El Bouaghi", 35.87, 7.11),
    ("05", "Batna", 35.56, 6.17),
    ("06", "Béjaïa", 36.75, 5.08),
    ("07", "Biskra", 34.85, 5.73),
    ("08", "Béchar", 31.62, -2.22),
    ("09", "Blida", 36.47, 2.83),
    ("10", "Bouira", 36.38, 3.90),
    ("11", "Tamanrasset", 22.79, 5.53),
    ("12", "Tébessa", 35.40, 8.12),
    ("13", "Tlemcen", 34.88, -1.32),
    ("14", "Tiaret", 35.37, 1.32),
    ("15", "Tizi Ouzou", 36.71, 4.05),
    ("16", "Alger", 36.75, 3.06),
    ("17", "Djelfa", 34.67, 3.25),
    ("18", "Jijel", 36.82, 5.77),
    ("19", "Sétif", 36.19, 5.41),
    ("20", "Saïda", 34.83, 0.15),
    ("21", "Skikda", 36.88, 6.91),
    ("22", "Sidi Bel Abbès", 35.19, -0.63),
    ("23", "Annaba", 36.90, 7.77),
    ("24", "Guelma", 36.46, 7.43),
    ("25", "Constantine", 36.37, 6.61),
    ("26", "Médéa", 36.26, 2.75),
    ("27", "Mostaganem", 35.93, 0.09),
    ("28", "M'Sila", 35.70, 4.54),
    ("29", "Mascara", 35.40, 0.14),
    ("30", "Ouargla", 31.95, 5.33),
    ("31", "Oran", 35.70, -0.63),
    ("32", "El Bayadh", 33.68, 1.02),
    ("33", "Illizi", 26.48, 8.47),
    ("34", "Bordj Bou Arréridj", 36.07, 4.76),
    ("35", "Boumerdès", 36.77, 3.48),
    ("36", "El Tarf", 36.77, 8.31),
    ("37", "Tindouf", 27.67, -8.15),
    ("38", "Tissemsilt", 35.61, 1.81),
    ("39", "El Oued", 33.37, 6.87),
    ("40", "Khenchela", 35.44, 7.14),
    ("41", "Souk Ahras", 36.29, 7.95),
    ("42", "Tipaza", 36.59, 2.45),
    ("43", "Mila", 36.45, 6.26),
    ("44", "Aïn Defla", 36.26, 1.97),
    ("45", "Naâma", 33.27, -0.31),
    ("46", "Aïn Témouchent", 35.30, -1.14),
    ("47", "Ghardaïa", 32.49, 3.67),
    ("48", "Relizane", 35.74, 0.56),
    ("49", "Timimoun", 29.26, 0.24),
    ("50", "Bordj Badji Mokhtar", 21.33, 0.95),
    ("51", "Ouled Djellal", 34.42, 5.07),
    ("52", "Béni Abbès", 30.13, -2.17),
    ("53", "In Salah", 27.19, 2.48),
    ("54", "In Guezzam", 19.57, 5.77),
    ("55", "Touggourt", 33.10, 6.06),
    ("56", "Djanet", 24.55, 9.48),
    ("57", "El M'Ghair", 33.95, 5.93),
    ("58", "El Meniaa", 30.58, 2.88),
]

DEFAULT_CAMPAIGN_NAME = "Général"
DEFAULT_DISASTER_TYPE_NAME = "Autre"


def seed(apps=None):
    """Idempotent. `apps` is the historical app registry when called from a
    migration, or None to use the real models (management command)."""
    if apps is not None:
        Wilaya = apps.get_model("core", "Wilaya")
        DisasterType = apps.get_model("core", "DisasterType")
        Campaign = apps.get_model("core", "Campaign")
    else:
        from core.models import Campaign, DisasterType, Wilaya

    for code, name, lat, lon in WILAYAS:
        Wilaya.objects.update_or_create(
            code=code,
            defaults={"name": name, "centroid_latitude": lat, "centroid_longitude": lon},
        )

    disaster_type, _ = DisasterType.objects.get_or_create(
        name=DEFAULT_DISASTER_TYPE_NAME, defaults={"icon": "info"}
    )

    campaign, _ = Campaign.objects.get_or_create(
        campaign_name=DEFAULT_CAMPAIGN_NAME,
        defaults={"disaster_type": disaster_type, "status": "active"},
    )
    campaign.authorized_wilayas.set(Wilaya.objects.all())
