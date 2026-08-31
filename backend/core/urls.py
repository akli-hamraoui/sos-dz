from rest_framework.routers import DefaultRouter

from core.views import (
    AppConfigurationView,
    CampaignViewSet,
    CollectionPointViewSet,
    CommentViewSet,
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
router.register("collection-points", CollectionPointViewSet, basename="collection-point")
router.register("comments", CommentViewSet, basename="comment")

urlpatterns = router.urls + [
    path("config/", AppConfigurationView.as_view(), name="app-configuration"),
]
