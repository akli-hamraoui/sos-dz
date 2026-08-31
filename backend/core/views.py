from django.shortcuts import get_object_or_404
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from core.access import authorized_for_write, get_presented_token, is_admin_request, owner_authorized
from core.models import (
    AppConfiguration,
    AuditLog,
    Campaign,
    DisasterType,
    LocationPing,
    Need,
    Pickup,
    ProgressUpdate,
    SupportRequest,
    Wilaya,
)
from core.permissions import write_guard
from core.serializers import (
    AnonymizeSerializer,
    AppConfigurationPublicSerializer,
    CampaignSerializer,
    DisasterTypeSerializer,
    IdentityRecoverySerializer,
    LocationPingSerializer,
    NeedCreateSerializer,
    NeedMapPinSerializer,
    NeedPublicSerializer,
    NeedUpdateGPSSerializer,
    PickupCreateSerializer,
    PickupPublicSerializer,
    ProgressUpdateCreateSerializer,
    ProgressUpdateSerializer,
    SupportRequestSerializer,
    WilayaSerializer,
)
from core.throttling import CreationRateThrottle


def log_admin_action(request, action_name, target):
    if is_admin_request(request):
        AuditLog.objects.create(admin_user=request.user, action=action_name, target_description=str(target))


class WilayaViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = Wilaya.objects.all()
    serializer_class = WilayaSerializer
    permission_classes = [AllowAny]
    pagination_class = None


class DisasterTypeViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = DisasterType.objects.all()
    serializer_class = DisasterTypeSerializer
    permission_classes = [AllowAny]
    pagination_class = None


class CampaignViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = Campaign.objects.all().prefetch_related("authorized_wilayas")
    serializer_class = CampaignSerializer
    permission_classes = [AllowAny]
    pagination_class = None

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("active_only") == "1":
            qs = qs.filter(status=Campaign.STATUS_ACTIVE)
        return qs


class AppConfigurationView(APIView):
    """Public subset of AppConfiguration -- read_only banner + moderation toggle."""

    permission_classes = [AllowAny]

    def get(self, request):
        return Response(AppConfigurationPublicSerializer(AppConfiguration.get_solo()).data)


class NeedViewSet(viewsets.GenericViewSet, mixins.ListModelMixin, mixins.RetrieveModelMixin):
    queryset = Need.objects.select_related("wilaya", "campaign", "disaster_type").prefetch_related("pickups__progress_updates")
    permission_classes = [AllowAny]

    def get_serializer_class(self):
        if self.action == "create":
            return NeedCreateSerializer
        return NeedPublicSerializer

    def get_throttles(self):
        if self.action in ("create",):
            return [CreationRateThrottle()]
        return []

    def get_queryset(self):
        qs = super().get_queryset()
        wilaya = self.request.query_params.get("wilaya")
        campaign = self.request.query_params.get("campaign")
        if wilaya:
            qs = qs.filter(wilaya_id=wilaya)
        if campaign:
            qs = qs.filter(campaign_id=campaign)
        return qs

    def create(self, request, *args, **kwargs):
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        need = serializer.save()
        out = NeedPublicSerializer(need).data
        out["access_token"] = need.access_token
        out["location_viewer_share_token"] = need.location_viewer_share_token
        return Response(out, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        need = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if need.is_anonymized:
            return Response({"detail": "This listing has been anonymized and is frozen from further edits."}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, need):
            return Response({"detail": "Not authorized: this access token doesn't match this need."}, status=status.HTTP_403_FORBIDDEN)

        data = request.data
        editable_fields = [
            "title", "estimated_quantity", "urgency", "commune", "location_description",
            "organization_or_person_name", "contact_email",
        ]
        changed = False
        for f in editable_fields:
            if f in data:
                setattr(need, f, data[f])
                changed = True

        if data.get("is_cancelled") is True and not need.is_cancelled:
            need.is_cancelled = True
            need.cancellation_reason = data.get("cancellation_reason", "")
            changed = True

        if changed:
            need.record_edit()
            need.save()
            need.recompute_status()
            log_admin_action(request, "edited need", need)

        return Response(NeedPublicSerializer(need).data)

    @action(detail=False, methods=["get"], url_path="locations")
    def locations(self, request):
        """Public: main map pins. Need locations only, never volunteer positions."""
        qs = self.get_queryset().exclude(is_cancelled=True)
        return Response(NeedMapPinSerializer(qs, many=True).data)

    @action(detail=True, methods=["get"], url_path="pickup-locations")
    def pickup_locations(self, request, pk=None):
        """Access-restricted: creator (token), share-link holder, or admin only."""
        need = self.get_object()
        viewer_token = request.query_params.get("viewer")
        allowed = (
            is_admin_request(request)
            or owner_authorized(request, need)
            or (viewer_token and not need.is_anonymized and viewer_token == need.location_viewer_share_token)
        )
        if not allowed:
            return Response(
                {"detail": "Not authorized to view this need's live location."},
                status=status.HTTP_403_FORBIDDEN,
            )
        active_pickups = need.pickups.exclude(status=Pickup.STATUS_CANCELLED)
        result = []
        for pickup in active_pickups:
            pings = list(pickup.location_pings.all())
            latest_update = pickup.progress_updates.order_by("-timestamp").first()
            result.append({
                "pickup": PickupPublicSerializer(pickup).data,
                "trail": LocationPingSerializer(pings, many=True).data,
                "latest_position": LocationPingSerializer(pings[-1]).data if pings else None,
                "latest_progress_text": latest_update.free_text if latest_update else None,
            })
        return Response(result)

    @action(detail=True, methods=["post"], url_path="regenerate-share-token")
    def regenerate_share_token(self, request, pk=None):
        need = self.get_object()
        if not (is_admin_request(request) or owner_authorized(request, need)):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)
        token = need.regenerate_share_token()
        log_admin_action(request, "regenerated share token", need)
        return Response({"location_viewer_share_token": token})

    @action(detail=True, methods=["post"], url_path="recover-access")
    def recover_access(self, request, pk=None):
        need = self.get_object()
        if need.is_anonymized:
            return Response({"detail": "This listing has been anonymized; access can no longer be recovered."}, status=status.HTTP_403_FORBIDDEN)
        serializer = IdentityRecoverySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        if not need.matches_identity(d["last_name"], d["first_name"], d["phone"], d["date_of_birth"]):
            return Response(
                {"detail": "No match. If this keeps happening, use the support/contact-admin form."},
                status=status.HTTP_403_FORBIDDEN,
            )
        token = need.regenerate_token()
        return Response({"access_token": token})

    @action(detail=True, methods=["post"], url_path="update-gps")
    def update_gps(self, request, pk=None):
        need = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if need.is_anonymized:
            return Response({"detail": "This listing has been anonymized and is frozen from further edits."}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, need):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)
        serializer = NeedUpdateGPSSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        need.latitude = serializer.validated_data["latitude"]
        need.longitude = serializer.validated_data["longitude"]
        need.position_accuracy = Need.POSITION_EXACT
        need.record_edit()
        need.save()
        return Response(NeedPublicSerializer(need).data)

    @action(detail=True, methods=["post"], url_path="anonymize")
    def anonymize(self, request, pk=None):
        need = self.get_object()
        if need.is_anonymized:
            return Response({"detail": "Already anonymized."})
        admin = is_admin_request(request)
        if not (admin or owner_authorized(request, need)):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)

        actor = need.OBFUSCATED_BY_ADMIN if admin else need.OBFUSCATED_BY_CREATOR
        is_active = need.overall_status in (Need.STATUS_OPEN, Need.STATUS_PARTIALLY_COVERED) and need.campaign.status != Campaign.STATUS_STOPPED
        if not admin and is_active:
            serializer = AnonymizeSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            if not serializer.validated_data["confirm"]:
                return Response(
                    {
                        "detail": "This listing is still active. Your contact details will be removed, "
                                  "others will no longer be able to reach you about this. Confirm to proceed.",
                        "requires_confirmation": True,
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
        need.anonymize(actor)
        AuditLog.objects.create(
            admin_user=request.user if admin else None,
            action="anonymized listing",
            target_description=f"Need #{need.pk}",
        )
        return Response(NeedPublicSerializer(need).data)


class PickupViewSet(viewsets.GenericViewSet, mixins.ListModelMixin, mixins.RetrieveModelMixin):
    queryset = Pickup.objects.select_related("need").prefetch_related("progress_updates")
    permission_classes = [AllowAny]

    def get_serializer_class(self):
        if self.action == "create":
            return PickupCreateSerializer
        return PickupPublicSerializer

    def get_throttles(self):
        if self.action == "create":
            return [CreationRateThrottle()]
        return []

    def create(self, request, *args, **kwargs):
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        pickup = serializer.save()
        pickup.need.recompute_status()
        out = PickupPublicSerializer(pickup).data
        out["access_token"] = pickup.access_token
        return Response(out, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        pickup = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if pickup.is_anonymized:
            return Response({"detail": "This listing has been anonymized and is frozen from further edits."}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, pickup):
            return Response({"detail": "Not authorized: this access token doesn't match this pickup."}, status=status.HTTP_403_FORBIDDEN)

        data = request.data
        if "content_brought" in data:
            pickup.content_brought = data["content_brought"]
        if "location_sharing_active" in data:
            pickup.location_sharing_active = bool(data["location_sharing_active"])
        if data.get("is_cancelled") is True and pickup.status != Pickup.STATUS_CANCELLED:
            pickup.status = Pickup.STATUS_CANCELLED
            pickup.cancellation_reason = data.get("cancellation_reason", "")
        pickup.save()
        pickup.need.recompute_status()
        log_admin_action(request, "edited pickup", pickup)
        return Response(PickupPublicSerializer(pickup).data)

    @action(detail=True, methods=["post"], url_path="deliver")
    def deliver(self, request, pk=None):
        pickup = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, pickup):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)
        pickup.mark_delivered()
        return Response(PickupPublicSerializer(pickup).data)

    @action(detail=True, methods=["post"], url_path="progress-updates")
    def add_progress_update(self, request, pk=None):
        """Always public/free-text; never blocked by GPS or connectivity --
        GPS on a progress update is optional and purely additive."""
        pickup = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, pickup):
            return Response({"detail": "Not authorized: only the volunteer who owns this pickup can post updates."}, status=status.HTTP_403_FORBIDDEN)
        serializer = ProgressUpdateCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        update = ProgressUpdate.objects.create(pickup=pickup, **serializer.validated_data)
        return Response(ProgressUpdateSerializer(update).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="location-pings")
    def add_location_ping(self, request, pk=None):
        pickup = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, pickup):
            return Response({"detail": "Not authorized: only this pickup's own volunteer can submit its position."}, status=status.HTTP_403_FORBIDDEN)
        serializer = LocationPingSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        from core.validators import validate_algeria_bounds
        validate_algeria_bounds(serializer.validated_data["latitude"], serializer.validated_data["longitude"])
        ping = LocationPing.objects.create(pickup=pickup, **serializer.validated_data)
        pickup.location_sharing_active = True
        pickup.save(update_fields=["location_sharing_active"])
        return Response(LocationPingSerializer(ping).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="recover-access")
    def recover_access(self, request, pk=None):
        pickup = self.get_object()
        if pickup.is_anonymized:
            return Response({"detail": "This listing has been anonymized; access can no longer be recovered."}, status=status.HTTP_403_FORBIDDEN)
        serializer = IdentityRecoverySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        if not pickup.matches_identity(d["last_name"], d["first_name"], d["phone"], d["date_of_birth"]):
            return Response(
                {"detail": "No match. If this keeps happening, use the support/contact-admin form."},
                status=status.HTTP_403_FORBIDDEN,
            )
        token = pickup.regenerate_token()
        return Response({"access_token": token})

    @action(detail=True, methods=["post"], url_path="anonymize")
    def anonymize(self, request, pk=None):
        pickup = self.get_object()
        if pickup.is_anonymized:
            return Response({"detail": "Already anonymized."})
        admin = is_admin_request(request)
        if not (admin or owner_authorized(request, pickup)):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)

        actor = pickup.OBFUSCATED_BY_ADMIN if admin else pickup.OBFUSCATED_BY_RESPONDER
        is_active = pickup.status == Pickup.STATUS_EN_ROUTE and pickup.need.campaign.status != Campaign.STATUS_STOPPED
        if not admin and is_active:
            serializer = AnonymizeSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            if not serializer.validated_data["confirm"]:
                return Response(
                    {
                        "detail": "This pickup is still active. Your contact details will be removed, "
                                  "others will no longer be able to reach you about this. Confirm to proceed.",
                        "requires_confirmation": True,
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
        pickup.anonymize(actor)
        AuditLog.objects.create(
            admin_user=request.user if admin else None,
            action="anonymized listing",
            target_description=f"Pickup #{pickup.pk}",
        )
        return Response(PickupPublicSerializer(pickup).data)


class SupportRequestViewSet(mixins.CreateModelMixin, viewsets.GenericViewSet):
    queryset = SupportRequest.objects.all()
    serializer_class = SupportRequestSerializer
    permission_classes = [AllowAny]
