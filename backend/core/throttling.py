from rest_framework.throttling import SimpleRateThrottle


class CreationRateThrottle(SimpleRateThrottle):
    """Max N creations/hour per IP address (N = settings.RATE_LIMIT_CREATIONS_PER_HOUR),
    applied to Need/Pickup/Comment/CollectionPoint creation endpoints."""

    scope = "creation"

    def get_cache_key(self, request, view):
        ident = getattr(request, "client_ip", None) or self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}
