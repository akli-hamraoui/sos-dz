from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path
from django.views.generic import RedirectView

urlpatterns = [
    path("i18n/", include("django.conf.urls.i18n")),  # powers the admin's language switcher
    path("admin/", admin.site.urls),
    path("api/", include("core.urls")),
    # The real, maintained app is the separately-deployed React frontend
    # (settings.FRONTEND_URL) -- this backend has no live "site" of its
    # own to serve at "/" (templates/index.html is the old, English-only
    # Wave 1-4 page, kept only for history/reference, never updated for
    # the fr/en/ar i18n work done for the React app).
    path("", RedirectView.as_view(url=settings.FRONTEND_URL, permanent=False)),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
