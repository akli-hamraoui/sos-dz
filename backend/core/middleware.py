def get_client_ip(request):
    """Best-effort client IP extraction, respecting a reverse proxy
    (Nginx on the IONOS VPS) via X-Forwarded-For."""
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "")


class RequestClientIPMiddleware:
    """Attaches request.client_ip for use by geo-restriction and rate limiting."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.client_ip = get_client_ip(request)
        return self.get_response(request)
