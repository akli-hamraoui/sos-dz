def get_client_ip(request):
    """Best-effort client IP extraction, respecting the Nginx reverse proxy
    in front of Django (see DEPLOYMENT.md: a single hop, over a unix
    socket -- Django only ever sees traffic that has already passed
    through it).

    X-Real-IP is set unconditionally by Nginx from its own connection info
    (`proxy_set_header X-Real-IP $remote_addr`), so a client cannot forge
    it -- prefer it whenever present.

    X-Forwarded-For is only ever appended to by Nginx
    (`$proxy_add_x_forwarded_for`), never overwritten, so a client can
    freely prepend any number of fake addresses before it reaches Nginx.
    Only the LAST entry (the one Nginx itself appended, from its own
    connection info) is trustworthy -- taking the first entry, as before,
    let a client bypass geo-restriction and rate limiting by simply
    sending a different fake first hop on every request.
    """
    real_ip = request.META.get("HTTP_X_REAL_IP")
    if real_ip:
        return real_ip.strip()
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR")
    if forwarded_for:
        return forwarded_for.split(",")[-1].strip()
    return request.META.get("REMOTE_ADDR", "")


class RequestClientIPMiddleware:
    """Attaches request.client_ip for use by geo-restriction and rate limiting."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.client_ip = get_client_ip(request)
        return self.get_response(request)
