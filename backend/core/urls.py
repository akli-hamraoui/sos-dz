from rest_framework.routers import DefaultRouter

from core.views import (
    AppConfigurationView,
    CampaignViewSet,
    ContentReportViewSet,
    DisasterTypeViewSet,
    NeedViewSet,
    PickupViewSet,
    SupportRequestViewSet,
    WilayaViewSet,
)
from django.urls import path

router = DefaultRouter()
router.register("wilayas", WilayaViewSet, basename="wilaya")
router.register("disaster-types", DisasterTypeViewSet, basename="disaster-type")
router.register("campaigns", CampaignViewSet, basename="campaign")
router.register("needs", NeedViewSet, basename="need")
router.register("pickups", PickupViewSet, basename="pickup")
router.register("support-requests", SupportRequestViewSet, basename="support-request")
router.register("content-reports", ContentReportViewSet, basename="content-report")

urlpatterns = router.urls + [
    path("config/", AppConfigurationView.as_view(), name="app-configuration"),
]
