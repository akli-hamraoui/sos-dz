"""Automatic duplicate suggestion at Need creation (Wave 3): same wilaya +
similar description + created within the last 24h -> non-blocking
suggestion. Deliberately simple text similarity (difflib), per spec
("basic text similarity is fine -- doesn't need to be sophisticated").
"""

from difflib import SequenceMatcher
from datetime import timedelta

from django.utils import timezone

SIMILARITY_THRESHOLD = 0.5


def find_similar_needs(wilaya_id, text, exclude_id=None):
    from core.models import Need

    text = (text or "").strip().lower()
    if not text or not wilaya_id:
        return []

    cutoff = timezone.now() - timedelta(hours=24)
    candidates = Need.objects.filter(wilaya_id=wilaya_id, created_at__gte=cutoff, is_cancelled=False)
    if exclude_id:
        candidates = candidates.exclude(pk=exclude_id)

    scored = []
    for need in candidates:
        candidate_text = f"{need.title} {need.location_description}".strip().lower()
        ratio = SequenceMatcher(None, text, candidate_text).ratio()
        if ratio >= SIMILARITY_THRESHOLD:
            scored.append((ratio, need))
    scored.sort(key=lambda pair: -pair[0])
    return [need for _, need in scored]


def find_similar_collection_points(organization, city_or_wilaya_name, phone):
    """Best-effort duplicate hint for the flyer-extraction review queue
    (core.models.ExtractedCollectionPoint.duplicate_of): unlike
    find_similar_needs above, this never blocks or auto-drops anything --
    per spec, the reviewer just gets shown "this looks like an existing
    point" with a link, and decides. Scores every non-closed point on
    phone match + organization/city text similarity (same simple
    difflib approach as find_similar_needs, since these are noisy fields
    extracted from photos, not exact-match keys) and returns the best one
    above a threshold, or None."""
    from core.models import CollectionPoint

    organization = (organization or "").strip().lower()
    city_or_wilaya_name = (city_or_wilaya_name or "").strip().lower()
    phone = (phone or "").strip()
    if not organization and not phone:
        return None

    best_match, best_score = None, 0.0
    for cp in CollectionPoint.objects.exclude(status=CollectionPoint.STATUS_CLOSED).select_related("wilaya"):
        phone_match = bool(phone) and (phone == cp.contact_phone or phone in (cp.other_phones or ""))
        org_ratio = SequenceMatcher(None, organization, (cp.organization or "").strip().lower()).ratio() if organization else 0
        cp_city = (cp.city or (cp.wilaya.name if cp.wilaya else "")).strip().lower()
        city_ratio = SequenceMatcher(None, city_or_wilaya_name, cp_city).ratio() if city_or_wilaya_name else 0
        score = (1.0 if phone_match else 0.0) * 0.6 + org_ratio * 0.25 + city_ratio * 0.15
        if score > best_score:
            best_match, best_score = cp, score

    return best_match if best_score >= 0.5 else None
