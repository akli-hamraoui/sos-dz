from rest_framework import serializers

from core.models import (
    AppConfiguration,
    Campaign,
    CollectionPoint,
    Comment,
    ContentReport,
    DamagePhoto,
    DeliveryPhoto,
    DisasterType,
    DuplicateReport,
    LocationPing,
    Need,
    Pickup,
    ProgressUpdate,
    SupportRequest,
    Wilaya,
)
from core.media_validation import validate_video_duration
from core.validators import validate_algeria_bounds


class ModeratedPhotoMixin:
    """Hides the image URL unless it's been approved (Wave 3) -- a
    rejected or still-pending photo must never be publicly visible,
    per spec. The id/status are still returned so the uploader/admin UI
    can show a "pending review" placeholder instead of a broken image."""

    def get_image(self, obj):
        if obj.moderation_status == Need.MODERATION_APPROVED:
            request = self.context.get("request")
            url = obj.image.url
            return request.build_absolute_uri(url) if request else url
        return None


class DamagePhotoSerializer(ModeratedPhotoMixin, serializers.ModelSerializer):
    image = serializers.SerializerMethodField()

    class Meta:
        model = DamagePhoto
        fields = ["id", "image", "moderation_status"]


class DeliveryPhotoSerializer(ModeratedPhotoMixin, serializers.ModelSerializer):
    image = serializers.SerializerMethodField()

    class Meta:
        model = DeliveryPhoto
        fields = ["id", "image", "moderation_status"]


class DuplicateReportCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = DuplicateReport
        fields = ["reporter_name", "reporter_phone"]


class ContentReportSerializer(serializers.ModelSerializer):
    class Meta:
        model = ContentReport
        fields = ["id", "media_type", "media_id", "reporter_name", "reporter_phone", "reason", "reported_at", "status"]
        read_only_fields = ["id", "reported_at", "status"]


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


class PickupListSerializer(serializers.ModelSerializer):
    """Lighter than PickupPublicSerializer for the global "deliveries in
    progress" list (no nested progress_updates/delivery_photos -- not
    needed for an overview row, and keeps the payload small for weak
    connectivity). Adds need_title/need_wilaya_name so the list is
    readable without a second request per row."""

    need_title = serializers.CharField(source="need.title", read_only=True)
    need_wilaya_name = serializers.CharField(source="need.wilaya.name", read_only=True)
    is_anonymized = serializers.BooleanField(read_only=True)

    class Meta:
        model = Pickup
        fields = [
            "id",
            "need",
            "need_title",
            "need_wilaya_name",
            "responder_type",
            "responder_last_name",
            "responder_first_name",
            "responder_phone",
            "organization_or_person_name",
            "content_brought",
            "status",
            "pickup_date",
            "actual_delivery_date",
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
    comments = serializers.SerializerMethodField()

    def get_comments(self, obj):
        roots = obj.comments.filter(parent_comment__isnull=True)
        return CommentSerializer(roots, many=True, context=self.context).data
    media_file = serializers.SerializerMethodField()

    def get_media_file(self, obj):
        """Hides the audio/video file unless it's been approved (Wave 3),
        same policy as damage/delivery photos."""
        if not obj.media_file or obj.media_moderation_status != Need.MODERATION_APPROVED:
            return None
        request = self.context.get("request")
        url = obj.media_file.url
        return request.build_absolute_uri(url) if request else url

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
            "comments",
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


# ---------------------------------------------------------------------------
# Community: collection points and comments (Wave 4)
# ---------------------------------------------------------------------------

class CommentSerializer(serializers.ModelSerializer):
    """author_phone is deliberately excluded -- never shown publicly, only
    used server-side for the loose self-delete match, per spec."""

    replies = serializers.SerializerMethodField()

    class Meta:
        model = Comment
        fields = ["id", "need", "collection_point", "parent_comment", "author_name", "text", "category", "confirmation_count", "created_at", "replies"]

    def get_replies(self, obj):
        # Only ever one level deep -- replies never nest replies.
        if obj.parent_comment_id is not None:
            return []
        return CommentSerializer(obj.replies.all(), many=True, context=self.context).data


class CommentCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Comment
        fields = ["need", "collection_point", "parent_comment", "author_name", "author_phone", "text", "category"]

    def validate(self, attrs):
        need, collection_point = attrs.get("need"), attrs.get("collection_point")
        if bool(need) == bool(collection_point):
            raise serializers.ValidationError("Exactly one of 'need' or 'collection_point' must be set.")
        parent = attrs.get("parent_comment")
        if parent is not None:
            if parent.parent_comment_id is not None:
                raise serializers.ValidationError("Replies cannot themselves be replied to (one level of nesting only).")
            attrs["category"] = ""  # category is only meaningful for root Need comments
        return attrs


class CommentDeleteSerializer(serializers.Serializer):
    author_name = serializers.CharField(required=False, allow_blank=True)
    author_phone = serializers.CharField(required=False, allow_blank=True)


class CollectionPointSerializer(serializers.ModelSerializer):
    wilaya_name = serializers.CharField(source="wilaya.name", read_only=True)
    comments = serializers.SerializerMethodField()

    class Meta:
        model = CollectionPoint
        fields = [
            "id", "wilaya", "wilaya_name", "point_name", "contact_name", "contact_phone",
            "organization", "location_description", "latitude", "longitude", "hours",
            "status", "created_at", "comments",
        ]

    def get_comments(self, obj):
        roots = obj.comments.filter(parent_comment__isnull=True)
        return CommentSerializer(roots, many=True, context=self.context).data


class CollectionPointCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = CollectionPoint
        fields = [
            "wilaya", "point_name", "contact_name", "contact_phone",
            "organization", "location_description", "latitude", "longitude", "hours",
        ]

    def validate(self, attrs):
        lat, lon = attrs.get("latitude"), attrs.get("longitude")
        if lat is not None or lon is not None:
            validate_algeria_bounds(lat, lon)
        return attrs


class CollectionPointMapPinSerializer(serializers.ModelSerializer):
    wilaya_name = serializers.CharField(source="wilaya.name", read_only=True)
    display_latitude = serializers.SerializerMethodField()
    display_longitude = serializers.SerializerMethodField()
    has_exact_position = serializers.SerializerMethodField()

    class Meta:
        model = CollectionPoint
        fields = [
            "id", "point_name", "contact_name", "contact_phone", "organization", "hours",
            "status", "wilaya_name", "display_latitude", "display_longitude", "has_exact_position",
        ]

    def get_has_exact_position(self, obj):
        return obj.latitude is not None

    def get_display_latitude(self, obj):
        return obj.latitude if obj.latitude is not None else obj.wilaya.centroid_latitude

    def get_display_longitude(self, obj):
        return obj.longitude if obj.longitude is not None else obj.wilaya.centroid_longitude


class CollectionPointCloseSerializer(serializers.Serializer):
    contact_name = serializers.CharField()
    contact_phone = serializers.CharField()
