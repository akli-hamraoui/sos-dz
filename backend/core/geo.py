"""Country-level centroid lookup for the flyer-extraction pipeline's
PRECISION_COUNTRY collection points (core.views.FlyerSubmissionViewSet,
core.serializers.CollectionPointMapPinSerializer): a point with no known
location beyond its country still needs *some* coordinate to render on the
map, and several such points in the same country should land on the exact
same spot so the frontend's existing "several points at one position ->
one bubble" clustering (InternationalCollectionPoints.jsx) picks them up
automatically -- no separate aggregation endpoint needed.
"""

from core.collection_point_geocoding import NominatimClient

# A small set of common destinations for the Algerian diaspora, checked
# first so the vast majority of PRECISION_COUNTRY points never need a
# network call at all. Anything else falls through to Nominatim (below)
# and is cached in CountryCentroidCache after the first lookup.
_COUNTRY_CENTROIDS = {
    "DZ": (28.0, 2.6),
    "FR": (46.6, 2.4),
    "BE": (50.6, 4.6),
    "DE": (51.1, 10.4),
    "NL": (52.2, 5.5),
    "ES": (40.3, -3.7),
    "IT": (42.8, 12.6),
    "GB": (54.0, -2.5),
    "CH": (46.8, 8.2),
    "CA": (56.1, -106.3),
    "US": (39.8, -98.6),
    "TN": (33.9, 9.5),
    "MA": (31.8, -7.1),
    "LY": (26.3, 17.2),
    "EG": (26.8, 30.8),
    "SA": (23.9, 45.1),
    "AE": (23.4, 53.8),
    "QA": (25.4, 51.2),
    "TR": (38.9, 35.2),
    "SE": (60.1, 18.6),
    "NO": (60.5, 8.5),
    "AU": (-25.3, 133.8),
    "MR": (20.3, -10.3),
    "ML": (17.6, -4.0),
    "SN": (14.5, -14.5),
}

_nominatim = NominatimClient()


def get_country_centroid(country_code, country_name=""):
    """Returns (lat, lon) for an ISO 3166-1 alpha-2 country_code, or None
    if it can't be resolved at all. Checks the hardcoded dict first, then
    CountryCentroidCache, then geocodes via Nominatim (using country_name
    as the query when given -- more reliable than a bare code) and caches
    the result -- see module docstring."""
    from core.models import CountryCentroidCache

    code = (country_code or "").strip().upper()
    if not code:
        return None
    if code in _COUNTRY_CENTROIDS:
        return _COUNTRY_CENTROIDS[code]

    cached = CountryCentroidCache.objects.filter(country_code=code).first()
    if cached:
        return cached.latitude, cached.longitude

    hit = _nominatim.search(country_name or code)
    if not hit:
        return None
    lat, lon, _ = hit
    CountryCentroidCache.objects.get_or_create(country_code=code, defaults={"latitude": lat, "longitude": lon})
    return lat, lon
