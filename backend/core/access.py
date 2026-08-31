"""Token / identity-match authorization helpers shared by Need and Pickup
endpoints. There is no session-based auth for citizens (see spec
AUTHENTICATION MODEL) -- authorization is either:
  - a valid access_token presented by the client (header X-Access-Token or
    body/query field access_token), or
  - an exact identity match (last name + first name + phone + DOB), or
  - an authenticated Django admin (is_staff/is_superuser).
"""


def is_admin_request(request):
    user = getattr(request, "user", None)
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


def get_presented_token(request):
    token = request.headers.get("X-Access-Token")
    if token:
        return token
    if hasattr(request, "data"):
        token = request.data.get("access_token")
        if token:
            return token
    return request.query_params.get("access_token") if hasattr(request, "query_params") else None


def owner_authorized(request, obj):
    """True if this request may act as the owner of obj (a Need or Pickup)."""
    token = get_presented_token(request)
    if token and not obj.is_anonymized and token == obj.access_token:
        return True
    return False


def authorized_for_write(request, obj):
    """Owner (token) or admin. Identity-match re-auth is handled separately
    by the explicit 'recover access' endpoint, which issues a fresh token
    rather than being accepted silently on every write."""
    return is_admin_request(request) or owner_authorized(request, obj)
