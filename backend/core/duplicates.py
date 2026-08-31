"""Automatic duplicate suggestion at Need creation (Wave 3): same wilaya +
similar description + created within the last 24h -> non-blocking
suggestion. Deliberately simple text similarity (difflib), per spec
("basic text similarity is fine -- doesn't need to be sophisticated").
"""

from datetime import timedelta
from difflib import SequenceMatcher

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
