"""Turns one ExtractedCollectionPoint into a real, public CollectionPoint --
shared by the flyer-extraction pipeline's auto-publish path
(core.views.FlyerSubmissionViewSet.create) and the Django Admin fallback
action (core.admin.publish_extracted_points, used for whatever a submission
couldn't auto-publish, e.g. every candidate point turning out to be a
duplicate).
"""

from core.models import CollectionPoint


def publish_extracted_point(child):
    """Creates the real CollectionPoint for one ExtractedCollectionPoint
    row, copying over its submission's flyer image, and records the link
    back (child.published_point) so this is never done twice for the same
    row. Does not check include_in_publish/duplicate_of/published_point
    itself -- the caller decides whether this child should be published at
    all."""
    point = CollectionPoint.objects.create(
        wilaya=child.wilaya,
        country_code=child.country_code,
        country_name=child.country_name,
        city=child.city,
        precision_level=child.precision_level,
        point_name=child.point_name,
        organization=child.organization,
        location_description=child.location_description or child.city or child.country_name or "Adresse non précisée",
        latitude=child.latitude,
        longitude=child.longitude,
        hours=child.hours,
        description=child.description,
        accepted_donations=child.accepted_donations,
        contact_name=child.contact_name,
        contact_phone=child.contact_phone,
        other_phones=child.other_phones,
        facebook_url=child.facebook_url,
        tiktok_url=child.tiktok_url,
        instagram_url=child.instagram_url,
    )
    submission = child.submission
    if submission.flyer_image:
        # Shares the same stored file rather than re-uploading it -- several
        # points from one flyer all show the same image, per spec ("the
        # flyer in common for all of them").
        point.flyer_image.name = submission.flyer_image.name
        point.flyer_moderation_status = submission.flyer_moderation_status
        point.flyer_moderated_by = submission.flyer_moderated_by
        point.save(update_fields=["flyer_image", "flyer_moderation_status", "flyer_moderated_by"])
    child.published_point = point
    child.save(update_fields=["published_point"])
    return point
