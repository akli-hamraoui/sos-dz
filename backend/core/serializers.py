from rest_framework import serializers

from core.models import (
    AppConfiguration,
    Campaign,
    DamagePhoto,
    DeliveryPhoto,
    DisasterType,
    LocationPing,
    Need,
    Pickup,
    ProgressUpdate,
    SupportRequest,
    Wilaya,
)
from core.media_validation import validate_video_duration
from core.validators import validate_algeria_bounds


class DamagePhotoSerializer(serializers.ModelSerializer):
    class Meta:
        model = DamagePhoto
        fields = ["id", "image"]


class DeliveryPhotoSerializer(serializers.ModelSerializer):
    class Meta:
        model = DeliveryPhoto
        fields = ["id", "image"]


class WilayaSerializer(serializers.ModelSerializer):
    class Meta:
        model = Wilaya
        fields = ["id", "code", "name", "centroid_latitude", "centroid_longitude"]


class DisasterTypeSerializer(serializers.ModelSerializer):
    class Meta:
        model = DisasterType
        fields = ["id", "name", "icon"]


class CampaignSerializer(serializers.ModelSerializer):
    authorized_wilayas = WilayaSerializer(many=True, read_only=True)

    class Meta:
        model = Campaign
        fields = [
            "id",
            "campaign_name",
            "disaster_type",
            "authorized_wilayas",
            "status",
            "created_at",
            "status_changed_at",
        ]


class ProgressUpdateSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProgressUpdate
        fields = ["id", "free_text", "timestamp", "gps_latitude", "gps_longitude"]
        read_only_fields = ["id", "timestamp"]


class ProgressUpdateCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProgressUpdate
        fields = ["free_text", "gps_latitude", "gps_longitude"]

    def validate(self, attrs):
        lat, lon = attrs.get("gps_latitude"), attrs.get("gps_longitude")
        if lat is not None or lon is not None:
            validate_algeria_bounds(lat, lon)
        return attrs


class LocationPingSerializer(serializers.ModelSerializer):
    class Meta:
        model = LocationPing
        fields = ["id", "latitude", "longitude", "recorded_at"]
        read_only_fields = ["id", "recorded_at"]


class PickupPublicSerializer(serializers.ModelSerializer):
    progress_updates = ProgressUpdateSerializer(many=True, read_only=True)
    delivery_photos = DeliveryPhotoSerializer(many=True, read_only=True)
    needs_verification = serializers.BooleanField(read_only=True)
    is_anonymized = serializers.BooleanField(read_only=True)

    class Meta:
        model = Pickup
        fields = [
            "id",
            "need",
            "responder_type",
            "responder_last_name",
            "responder_first_name",
            "responder_phone",
            "responder_email",
            "organization_or_person_name",
            "content_brought",
            "status",
            "cancellation_reason",
            "location_sharing_active",
            "pickup_date",
            "actual_delivery_date",
            "created_at",
            "progress_updates",
            "delivery_photos",
            "needs_verification",
            "is_anonymized",
        ]


class PickupCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Pickup
        fields = [
            "need",
            "responder_type",
            "responder_last_name",
            "responder_first_name",
            "responder_phone",
            "responder_email",
            "responder_date_of_birth",
            "organization_or_person_name",
            "content_brought",
            "location_sharing_active",
        ]

    def validate_need(self, need):
        if need.is_cancelled:
            raise serializers.ValidationError("This need has been cancelled.")
        if need.campaign.status != Campaign.STATUS_ACTIVE:
            raise serializers.ValidationError(
                "This campaign is not accepting new pickups right now."
            )
        return need


class NeedPublicSerializer(serializers.ModelSerializer):
    pickups = PickupPublicSerializer(many=True, read_only=True)
    damage_photos = DamagePhotoSerializer(many=True, read_only=True)
    wilaya_name = serializers.CharField(source="wilaya.name", read_only=True)
    is_anonymized = serializers.BooleanField(read_only=True)

    class Meta:
        model = Need
        fields = [
            "id",
            "campaign",
            "disaster_type",
            "title",
            "estimated_quantity",
            "urgency",
            "wilaya",
            "wilaya_name",
            "commune",
            "location_description",
            "latitude",
            "longitude",
            "position_accuracy",
            "contact_last_name",
            "contact_first_name",
            "contact_phone",
            "contact_email",
            "organization_or_person_name",
            "media_type",
            "media_file",
            "media_moderation_status",
            "damage_photos",
            "overall_status",
            "covered_quantity",
            "is_cancelled",
            "cancellation_reason",
            "created_at",
            "last_modified_at",
            "edit_history",
            "pickups",
            "is_anonymized",
        ]


class NeedMapPinSerializer(serializers.ModelSerializer):
    """Public main-map endpoint: Need location pins only, never volunteer
    positions. Falls back to the wilaya centroid when no precise GPS."""

    wilaya_name = serializers.CharField(source="wilaya.name", read_only=True)
    display_latitude = serializers.SerializerMethodField()
    display_longitude = serializers.SerializerMethodField()
    has_exact_position = serializers.SerializerMethodField()

    class Meta:
        model = Need
        fields = [
            "id",
            "title",
            "urgency",
            "wilaya_name",
            "overall_status",
            "location_description",
            "display_latitude",
            "display_longitude",
            "has_exact_position",
        ]

    def get_has_exact_position(self, obj):
        return obj.position_accuracy == Need.POSITION_EXACT and obj.latitude is not None

    def get_display_latitude(self, obj):
        if obj.latitude is not None:
            return obj.latitude
        return obj.wilaya.centroid_latitude

    def get_display_longitude(self, obj):
        if obj.longitude is not None:
            return obj.longitude
        return obj.wilaya.centroid_longitude


class NeedCreateSerializer(serializers.ModelSerializer):
    media_file = serializers.FileField(required=False, allow_null=True)

    class Meta:
        model = Need
        fields = [
            "campaign",
            "disaster_type",
            "title",
            "estimated_quantity",
            "urgency",
            "wilaya",
            "commune",
            "location_description",
            "latitude",
            "longitude",
            "contact_last_name",
            "contact_first_name",
            "contact_phone",
            "contact_email",
            "contact_date_of_birth",
            "organization_or_person_name",
            "media_type",
            "media_file",
        ]

    def validate(self, attrs):
        campaign = attrs["campaign"]
        wilaya = attrs["wilaya"]
        if campaign.status != Campaign.STATUS_ACTIVE:
            raise serializers.ValidationError(
                "This campaign is not accepting new needs right now (paused or stopped)."
            )
        if not campaign.authorized_wilayas.filter(pk=wilaya.pk).exists():
            raise serializers.ValidationError(
                "This wilaya is not authorized for the selected campaign."
            )
        lat, lon = attrs.get("latitude"), attrs.get("longitude")
        if lat is not None or lon is not None:
            validate_algeria_bounds(lat, lon)
        media_type = attrs.get("media_type", Need.MEDIA_TEXT)
        media_file = attrs.get("media_file")
        if media_type in (Need.MEDIA_AUDIO, Need.MEDIA_VIDEO) and not media_file:
            raise serializers.ValidationError(f"A recorded {media_type} file is required for media_type={media_type}.")
        if media_type == Need.MEDIA_VIDEO and media_file:
            validate_video_duration(media_file)
        return attrs

    def create(self, validated_data):
        has_gps = validated_data.get("latitude") is not None and validated_data.get("longitude") is not None
        validated_data["position_accuracy"] = Need.POSITION_EXACT if has_gps else Need.POSITION_APPROXIMATE
        need = Need.objects.create(**validated_data)
        need.recompute_status()
        return need


class NeedUpdateGPSSerializer(serializers.Serializer):
    """A Need's creator adding/updating precise GPS after the fact."""

    latitude = serializers.FloatField()
    longitude = serializers.FloatField()

    def validate(self, attrs):
        validate_algeria_bounds(attrs["latitude"], attrs["longitude"])
        return attrs


class IdentityRecoverySerializer(serializers.Serializer):
    last_name = serializers.CharField()
    first_name = serializers.CharField()
    phone = serializers.CharField()
    date_of_birth = serializers.DateField()


class AnonymizeSerializer(serializers.Serializer):
    confirm = serializers.BooleanField(default=False)


class AppConfigurationPublicSerializer(serializers.ModelSerializer):
    class Meta:
        model = AppConfiguration
        fields = ["mode", "media_moderation_active"]


class SupportRequestSerializer(serializers.ModelSerializer):
    class Meta:
        model = SupportRequest
        fields = ["id", "requester_phone", "related_listing_description", "message", "created_at"]
        read_only_fields = ["id", "created_at"]
