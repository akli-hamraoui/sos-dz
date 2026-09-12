from rest_framework import serializers

from core.models import (
    AdminContactPhone,
    AppConfiguration,
    Campaign,
    CollectionPoint,
    Comment,
    ContentReport,
    DamagePhoto,
    DeliveryPhoto,
    DisasterType,
    DuplicateReport,
    ExtractedCollectionPoint,
    FlyerSubmission,
    LocationPing,
    Need,
    Pickup,
    ProgressUpdate,
    SupportRequest,
    Wilaya,
)
from core.media_validation import validate_video_duration, validate_video_size
from core.permissions import is_request_admin
from core.validators import (
    check_recovery_code_available,
    is_within_algeria_bounds,
    normalize_place_name,
    validate_algeria_bounds,
    validate_social_url,
)


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
        fields = ["id", "image", "moderation_status", "moderated_by"]


class DeliveryPhotoSerializer(ModeratedPhotoMixin, serializers.ModelSerializer):
    image = serializers.SerializerMethodField()

    class Meta:
        model = DeliveryPhoto
        fields = ["id", "image", "moderation_status", "moderated_by"]


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
    """Public: nested inside PickupPublicSerializer, which is itself
    reachable with no authentication at all via the Need detail endpoint.
    Deliberately excludes gps_latitude/gps_longitude -- exposing them here
    would leak a responder's live position to anyone, bypassing the
    access-controlled pickup-locations endpoint's privacy boundary (see
    also LocationPing, the actual live-tracking model behind that
    endpoint). GPS is only ever echoed back to the pickup's own token
    holder right after they submit it, via
    ProgressUpdateWithGPSSerializer below -- never in any publicly
    readable response."""

    class Meta:
        model = ProgressUpdate
        fields = ["id", "free_text", "timestamp"]
        read_only_fields = ["id", "timestamp"]


class ProgressUpdateWithGPSSerializer(serializers.ModelSerializer):
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


class PickupParentInfoMixin(serializers.Serializer):
    """need_title/need_wilaya_name (or their collection_point_* equivalents,
    whichever of the two this pickup belongs to) -- shared by any Pickup
    serializer that needs to be readable without a second request to fetch
    its parent. SerializerMethodField rather than source="need.title"
    because exactly one of need/collection_point is ever set on a given
    pickup -- a dotted source would try to traverse through the unset
    (None) one. Subclasses serializers.Serializer (not just a plain mixin)
    so DRF's SerializerMetaclass actually picks up these declared fields
    through inheritance -- a plain-object mixin's Field attributes are
    silently ignored by ModelSerializer's field auto-generation."""

    need_title = serializers.SerializerMethodField()
    need_wilaya_name = serializers.SerializerMethodField()
    collection_point_name = serializers.SerializerMethodField()
    collection_point_wilaya_name = serializers.SerializerMethodField()

    def get_need_title(self, obj):
        return obj.need.title if obj.need_id else None

    def get_need_wilaya_name(self, obj):
        return obj.need.wilaya.name if obj.need_id else None

    def get_collection_point_name(self, obj):
        return obj.collection_point.point_name if obj.collection_point_id else None

    def get_collection_point_wilaya_name(self, obj):
        return obj.collection_point.wilaya.name if obj.collection_point_id else None


class PickupPublicSerializer(PickupParentInfoMixin, serializers.ModelSerializer):
    progress_updates = ProgressUpdateSerializer(many=True, read_only=True)
    delivery_photos = DeliveryPhotoSerializer(many=True, read_only=True)
    needs_verification = serializers.BooleanField(read_only=True)
    is_anonymized = serializers.BooleanField(read_only=True)
    # Same public info already shown on the aggregate deliveries map
    # (PickupViewSet.live_locations) -- exposed here too so this pickup's
    # own detail page (PickupDetail.jsx) can show it without a separate call.
    current_position = serializers.SerializerMethodField()
    # Same "commentable" pattern as Need/CollectionPoint (see
    # CollectionPointSerializer.get_comments) -- lets someone leave a
    # comment on this transporter (e.g. to confirm contact was made),
    # shown on this pickup's own detail page (PickupDetail.jsx).
    comments = serializers.SerializerMethodField()

    def get_current_position(self, obj):
        return obj.latest_known_position()

    def get_comments(self, obj):
        roots = obj.comments.filter(parent_comment__isnull=True)
        return CommentSerializer(roots, many=True, context=self.context).data

    class Meta:
        model = Pickup
        fields = [
            "id",
            "need",
            "need_title",
            "need_wilaya_name",
            "collection_point",
            "collection_point_name",
            "collection_point_wilaya_name",
            "responder_type",
            "responder_name",
            "responder_phone",
            "responder_email",
            "organization_or_person_name",
            "content_brought",
            "status",
            "cancellation_reason",
            "location_sharing_active",
            "departure_description",
            "departure_latitude",
            "departure_longitude",
            "pickup_date",
            "actual_delivery_date",
            "created_at",
            "progress_updates",
            "delivery_photos",
            "needs_verification",
            "is_anonymized",
            "current_position",
            "comments",
        ]


class PickupListSerializer(PickupParentInfoMixin, serializers.ModelSerializer):
    """Lighter than PickupPublicSerializer for the global "deliveries in
    progress" list (no nested progress_updates/full delivery_photos list --
    not needed for an overview row, and keeps the payload small for weak
    connectivity). `photo` is the one exception: a single approved delivery
    photo URL (not the full array+moderation metadata), letting the list
    row show a thumbnail without pulling in everything
    PickupPublicSerializer's own delivery_photos carries."""

    is_anonymized = serializers.BooleanField(read_only=True)
    photo = serializers.SerializerMethodField()

    class Meta:
        model = Pickup
        fields = [
            "id",
            "need",
            "need_title",
            "need_wilaya_name",
            "collection_point",
            "collection_point_name",
            "collection_point_wilaya_name",
            "responder_type",
            "responder_name",
            "responder_phone",
            "organization_or_person_name",
            "content_brought",
            "status",
            "pickup_date",
            "actual_delivery_date",
            "is_anonymized",
            "photo",
        ]

    def get_photo(self, obj):
        approved = next((p for p in obj.delivery_photos.all() if p.moderation_status == Need.MODERATION_APPROVED), None)
        if not approved:
            return None
        request = self.context.get("request")
        url = approved.image.url
        return request.build_absolute_uri(url) if request else url


class PickupCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Pickup
        fields = [
            "need",
            "collection_point",
            "responder_type",
            "responder_name",
            "responder_phone",
            "responder_email",
            "organization_or_person_name",
            "content_brought",
            "location_sharing_active",
            "recovery_code",
            "departure_description",
            "departure_latitude",
            "departure_longitude",
        ]

    def validate_need(self, need):
        if need.is_cancelled:
            raise serializers.ValidationError("This need has been cancelled.")
        if need.campaign.status != Campaign.STATUS_ACTIVE:
            raise serializers.ValidationError(
                "This campaign is not accepting new pickups right now."
            )
        return need

    def validate_collection_point(self, collection_point):
        if collection_point.status != CollectionPoint.STATUS_ACTIVE:
            raise serializers.ValidationError("This collection point is closed.")
        if collection_point.is_international:
            raise serializers.ValidationError("International collection points don't accept deliveries or couriers.")
        return collection_point

    def validate_recovery_code(self, value):
        return check_recovery_code_available(Pickup, value)

    def validate(self, attrs):
        need, collection_point = attrs.get("need"), attrs.get("collection_point")
        if bool(need) == bool(collection_point):
            raise serializers.ValidationError("Exactly one of 'need' or 'collection_point' must be set.")
        lat, lon = attrs.get("departure_latitude"), attrs.get("departure_longitude")
        if lat is not None or lon is not None:
            if lat is None or lon is None:
                raise serializers.ValidationError("departure_latitude and departure_longitude must be provided together.")
            validate_algeria_bounds(lat, lon)
        return attrs


class NeedPublicSerializer(serializers.ModelSerializer):
    pickups = PickupPublicSerializer(many=True, read_only=True)
    damage_photos = DamagePhotoSerializer(many=True, read_only=True)
    wilaya_name = serializers.CharField(source="wilaya.name", read_only=True)
    is_anonymized = serializers.BooleanField(read_only=True)
    comments = serializers.SerializerMethodField()

    def get_comments(self, obj):
        roots = obj.comments.filter(parent_comment__isnull=True)
        return CommentSerializer(roots, many=True, context=self.context).data
    voice_file = serializers.SerializerMethodField()
    video_file = serializers.SerializerMethodField()

    def get_voice_file(self, obj):
        """Voice is never moderated (no visual content for NSFWJS), so
        unlike video it's shown as soon as it exists."""
        if not obj.voice_file:
            return None
        request = self.context.get("request")
        url = obj.voice_file.url
        return request.build_absolute_uri(url) if request else url

    def get_video_file(self, obj):
        """Hides the video file unless it's been approved (Wave 3), same
        policy as damage/delivery photos."""
        if not obj.video_file or obj.video_moderation_status != Need.MODERATION_APPROVED:
            return None
        request = self.context.get("request")
        url = obj.video_file.url
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
            "description",
            "latitude",
            "longitude",
            "position_accuracy",
            "has_no_location",
            "contact_name",
            "contact_phone",
            "other_phones",
            "contact_email",
            "organization_or_person_name",
            "voice_file",
            "video_file",
            "video_moderation_status",
            "video_moderated_by",
            "damage_photos",
            "overall_status",
            "voice_processing_status",
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
    # First approved damage photo, if any -- lets the map popup offer a
    # "view photo" shortcut without a second request, same moderation gate
    # as NeedPublicSerializer's own damage_photos.
    photo = serializers.SerializerMethodField()
    # Already public on the need's own detail endpoint (NeedPublicSerializer)
    # -- exposed here too so the map's "sans localisation" bubble popup (see
    # NeedsList.jsx) can offer a "listen" button per SOS without a second
    # request per item.
    voice_file = serializers.SerializerMethodField()

    class Meta:
        model = Need
        fields = [
            "id",
            "title",
            "urgency",
            "wilaya",
            "wilaya_name",
            "overall_status",
            "location_description",
            "display_latitude",
            "display_longitude",
            "has_exact_position",
            "has_no_location",
            "photo",
            "voice_file",
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

    def get_photo(self, obj):
        approved = next((p for p in obj.damage_photos.all() if p.moderation_status == Need.MODERATION_APPROVED), None)
        if not approved:
            return None
        request = self.context.get("request")
        url = approved.image.url
        return request.build_absolute_uri(url) if request else url

    def get_voice_file(self, obj):
        if not obj.voice_file:
            return None
        request = self.context.get("request")
        url = obj.voice_file.url
        return request.build_absolute_uri(url) if request else url


class NeedCreateSerializer(serializers.ModelSerializer):
    location_description = serializers.CharField(required=False, allow_blank=True)
    voice_file = serializers.FileField(required=False, allow_null=True)
    video_file = serializers.FileField(required=False, allow_null=True)
    # Optional here (unlike the model field, which has no default) -- the
    # guided voice flow has no wilaya picker of its own and lets the
    # reporter decline geolocation entirely, so it never sends this field.
    # validate() below assigns a fallback wilaya and flags has_no_location
    # in that case; every other caller (CreateNeed.jsx, always sends one)
    # is unaffected.
    wilaya = serializers.PrimaryKeyRelatedField(queryset=Wilaya.objects.all(), required=False)

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
            "description",
            "latitude",
            "longitude",
            "contact_name",
            "contact_phone",
            "other_phones",
            "contact_email",
            "organization_or_person_name",
            "voice_file",
            "video_file",
            "recovery_code",
        ]

    def validate_recovery_code(self, value):
        return check_recovery_code_available(Need, value)

    def validate(self, attrs):
        campaign = attrs["campaign"]
        if campaign.status != Campaign.STATUS_ACTIVE:
            raise serializers.ValidationError(
                "This campaign is not accepting new needs right now (paused or stopped)."
            )
        wilaya = attrs.get("wilaya")
        if wilaya is None:
            # No location fix at all (guided voice flow, geolocation
            # declined/failed) -- fall back to Alger (the capital, the
            # single most-likely-relevant wilaya when none is known) if
            # it's authorized for this campaign, otherwise the first
            # authorized wilaya alphabetically, so submission never dead-
            # ends just because nothing more specific was available.
            # Picked in Python via normalize_place_name, not
            # .order_by("name") -- the database's raw string ordering
            # sorts an accented name like "Aïn Defla" *after* plain-ASCII
            # ones (confirmed: it lost to "Annaba" this way on the real
            # "Feux en Algérie" campaign, which has no Alger to fall back
            # to first), which has nothing to do with the actual alphabet.
            wilaya = campaign.authorized_wilayas.filter(name="Alger").first() or min(
                campaign.authorized_wilayas.all(), key=lambda w: normalize_place_name(w.name), default=None
            )
            if wilaya is None:
                raise serializers.ValidationError({"wilaya": "This field is required."})
            attrs["wilaya"] = wilaya
            # A fallback wilaya is only administrative metadata. If precise
            # GPS was supplied (admin SOS voice abroad), keep the listing as
            # precisely located instead of marking it as "no location".
            if attrs.get("latitude") is None or attrs.get("longitude") is None:
                attrs["has_no_location"] = True
        elif not campaign.authorized_wilayas.filter(pk=wilaya.pk).exists():
            raise serializers.ValidationError(
                "This wilaya is not authorized for the selected campaign."
            )
        lat, lon = attrs.get("latitude"), attrs.get("longitude")
        if lat is not None or lon is not None:
            request = self.context.get("request")
            view = self.context.get("view")
            admin_voice_sos = (
                getattr(view, "action", None) == "create_via_voice_guide"
                and is_request_admin(request)
            )
            if not admin_voice_sos:
                validate_algeria_bounds(lat, lon)
            elif not is_within_algeria_bounds(lat, lon):
                # An admin testing the guided voice SOS from outside
                # Algeria (their own device's real GPS) must not publish a
                # listing pinned in their own country -- this is an
                # Algeria-only disaster relief map. Drop the coordinates
                # instead of keeping them; NeedPublicSerializer/
                # NeedMapSerializer's display_latitude/longitude already
                # fall back to the wilaya's own centroid whenever
                # latitude/longitude are None, so the pin still lands in
                # the right wilaya (e.g. Tizi Ouzou) rather than nowhere.
                attrs["latitude"] = None
                attrs["longitude"] = None
        description = (attrs.get("description") or "").strip()
        location_description = (attrs.get("location_description") or "").strip()
        voice_file = attrs.get("voice_file")
        video_file = attrs.get("video_file")
        if not description and not location_description and not voice_file and not video_file:
            raise serializers.ValidationError(
                "Please provide at least one of: a text description, a voice message, or a video."
            )
        if video_file:
            validate_video_size(video_file)
            validate_video_duration(video_file)
        # contact_name/contact_phone are both optional -- the access_token
        # returned on creation is always the primary way back in, but
        # without a name+phone or a recovery_code there would be no
        # fallback at all for recovering access from a different
        # device/browser (see Need.matches_identity/matches_code).
        has_name_phone = (attrs.get("contact_name") or "").strip() and (attrs.get("contact_phone") or "").strip()
        has_code = (attrs.get("recovery_code") or "").strip()
        if not has_name_phone and not has_code:
            raise serializers.ValidationError(
                "Please provide either your name and phone, or set a recovery code, so you can manage this listing later."
            )
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
    """Either `code` (the memorable code optionally set at creation) or the
    `name`+`phone` fallback must be provided -- see the view, which tries
    the code first when present."""

    code = serializers.CharField(required=False, allow_blank=True)
    name = serializers.CharField(required=False, allow_blank=True)
    phone = serializers.CharField(required=False, allow_blank=True)

    def validate(self, attrs):
        if not attrs.get("code") and not (attrs.get("name") and attrs.get("phone")):
            raise serializers.ValidationError("Provide either a code, or both name and phone.")
        return attrs


class AnonymizeSerializer(serializers.Serializer):
    confirm = serializers.BooleanField(default=False)


class AdminContactPhoneSerializer(serializers.ModelSerializer):
    class Meta:
        model = AdminContactPhone
        fields = ["phone", "label"]


class AppConfigurationPublicSerializer(serializers.ModelSerializer):
    contact_phones = AdminContactPhoneSerializer(many=True, read_only=True)

    class Meta:
        model = AppConfiguration
        fields = ["mode", "media_moderation_active", "contact_phones", "admin_contact_email"]


class SupportRequestSerializer(serializers.ModelSerializer):
    class Meta:
        model = SupportRequest
        fields = ["id", "category", "requester_phone", "requester_email", "related_listing_description", "message", "created_at"]
        read_only_fields = ["id", "created_at"]

    def validate(self, attrs):
        if not attrs.get("requester_phone") and not attrs.get("requester_email"):
            raise serializers.ValidationError(
                "Please provide at least one of: your phone number or your email, so the admin can follow up."
            )
        return attrs


# ---------------------------------------------------------------------------
# Community: collection points and comments (Wave 4)
# ---------------------------------------------------------------------------

class CommentSerializer(serializers.ModelSerializer):
    """author_phone is deliberately excluded -- never shown publicly, only
    used server-side for the loose self-delete match, per spec."""

    replies = serializers.SerializerMethodField()

    class Meta:
        model = Comment
        fields = ["id", "need", "collection_point", "pickup", "parent_comment", "author_name", "text", "category", "confirmation_count", "created_at", "replies"]

    def get_replies(self, obj):
        # Only ever one level deep -- replies never nest replies.
        if obj.parent_comment_id is not None:
            return []
        return CommentSerializer(obj.replies.all(), many=True, context=self.context).data


class CommentCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = Comment
        fields = ["need", "collection_point", "pickup", "parent_comment", "author_name", "text", "category"]

    def validate(self, attrs):
        targets = [attrs.get("need"), attrs.get("collection_point"), attrs.get("pickup")]
        if sum(1 for t in targets if t) != 1:
            raise serializers.ValidationError("Exactly one of 'need', 'collection_point', or 'pickup' must be set.")
        parent = attrs.get("parent_comment")
        if parent is not None:
            if parent.parent_comment_id is not None:
                raise serializers.ValidationError("Replies cannot themselves be replied to (one level of nesting only).")
            attrs["category"] = ""  # category is only meaningful for root Need comments
        return attrs


class CollectionPointSerializer(serializers.ModelSerializer):
    # SerializerMethodField, not CharField(source="wilaya.name") -- an
    # international point has no wilaya at all (see is_international below).
    wilaya_name = serializers.SerializerMethodField()
    comments = serializers.SerializerMethodField()
    flyer_image = serializers.SerializerMethodField()
    created_from_flyer = serializers.SerializerMethodField()
    is_international = serializers.BooleanField(read_only=True)
    # Same "a listing carries its own pickups" convention as
    # NeedPublicSerializer -- lets a courier's take-charge/delivery from
    # this collection point (and its live tracking state) show up on the
    # point's own detail page, same UI/logic as a Need's pickups. Always
    # empty for an international point -- Pickup.collection_point rejects
    # ever attaching a delivery to one (see PickupCreateSerializer).
    pickups = PickupPublicSerializer(many=True, read_only=True)

    class Meta:
        model = CollectionPoint
        fields = [
            "id", "wilaya", "wilaya_name", "country_code", "country_name", "is_international",
            "city", "precision_level", "point_name", "contact_name", "contact_phone",
            "other_phones", "organization", "location_description", "latitude", "longitude", "hours",
            "description", "accepted_donations", "status", "created_at", "comments", "pickups",
            "facebook_url", "tiktok_url", "instagram_url",
            "flyer_image", "flyer_moderation_status", "flyer_moderated_by", "created_from_flyer",
        ]

    def get_wilaya_name(self, obj):
        return obj.wilaya.name if obj.wilaya_id else None

    def get_comments(self, obj):
        roots = obj.comments.filter(parent_comment__isnull=True)
        return CommentSerializer(roots, many=True, context=self.context).data

    def get_created_from_flyer(self, obj):
        # published_point uses related_name="+" (see models.py), so there's
        # no reverse accessor -- this point was auto-published from the
        # flyer pipeline (core.flyer_publish.publish_extracted_point) iff
        # some ExtractedCollectionPoint row points back to it. Distinct
        # from flyer_image being set: a manually-created point can also
        # carry its own attached flyer photo (CollectionPointCreateSerializer),
        # so that alone wouldn't tell them apart.
        return ExtractedCollectionPoint.objects.filter(published_point_id=obj.id).exists()

    def get_flyer_image(self, obj):
        # Same "hidden until approved" gate as Need.video_file (see
        # NeedPublicSerializer.get_video_file) -- flyer_moderation_status
        # and flyer_moderated_by are still exposed as their own fields
        # above so the frontend can show a pending/rejected badge same as
        # it does for damage/delivery photos.
        if not obj.flyer_image or obj.flyer_moderation_status != Need.MODERATION_APPROVED:
            return None
        request = self.context.get("request")
        url = obj.flyer_image.url
        return request.build_absolute_uri(url) if request else url


class CollectionPointCreateSerializer(serializers.ModelSerializer):
    wilaya = serializers.PrimaryKeyRelatedField(queryset=Wilaya.objects.all(), required=False, allow_null=True)

    class Meta:
        model = CollectionPoint
        fields = [
            "wilaya", "country_code", "country_name", "point_name", "contact_name", "contact_phone", "other_phones",
            "organization", "location_description", "latitude", "longitude", "hours",
            "description", "accepted_donations", "facebook_url", "tiktok_url", "instagram_url", "flyer_image",
            "recovery_code",
        ]

    def validate_facebook_url(self, value):
        return validate_social_url(value)

    def validate_tiktok_url(self, value):
        return validate_social_url(value)

    def validate_instagram_url(self, value):
        return validate_social_url(value)

    def validate_recovery_code(self, value):
        return check_recovery_code_available(CollectionPoint, value)

    def validate(self, attrs):
        lat, lon = attrs.get("latitude"), attrs.get("longitude")
        country_code = (attrs.get("country_code") or "").strip().upper()
        if country_code:
            # International (see CollectionPoint.country_code) -- created
            # from a separate page (InternationalCollectionPoints.jsx) that
            # never offers Algeria as a country choice in the first place;
            # this is the server-side backstop against a direct API call.
            if country_code == "DZ":
                raise serializers.ValidationError("Algeria is not a valid country for an international collection point.")
            if attrs.get("wilaya") is not None:
                raise serializers.ValidationError("An international collection point cannot have a wilaya.")
            if lat is None or lon is None:
                raise serializers.ValidationError("An exact position (map pin) is required for an international collection point.")
            if is_within_algeria_bounds(lat, lon):
                # Distinct, matchable message (see apiErrors.js/the
                # international create page) -- rendered with an actual
                # link to the national create page, not just plain text.
                raise serializers.ValidationError(
                    {"latitude": ["This position is in Algeria. Please use the national collection points page instead."]}
                )
            attrs["country_code"] = country_code
            attrs["country_name"] = (attrs.get("country_name") or "").strip() or country_code
        else:
            if attrs.get("wilaya") is None:
                raise serializers.ValidationError("Wilaya is required for a national collection point.")
            validate_algeria_bounds(lat, lon)
            attrs["country_code"] = ""
            attrs["country_name"] = ""
        # contact_name/contact_phone are both optional, but a point with
        # neither and no recovery_code either would have absolutely no way
        # for its creator to prove ownership later (see matches_creator's
        # own blank-vs-blank guard) -- at least one path must exist.
        has_name_phone = (attrs.get("contact_name") or "").strip() and (attrs.get("contact_phone") or "").strip()
        has_code = (attrs.get("recovery_code") or "").strip()
        if not has_name_phone and not has_code:
            raise serializers.ValidationError(
                "Please provide either your name and phone, or set a recovery code, so you can manage this listing later."
            )
        return attrs


class CollectionPointMapPinSerializer(serializers.ModelSerializer):
    wilaya_name = serializers.SerializerMethodField()
    display_latitude = serializers.SerializerMethodField()
    display_longitude = serializers.SerializerMethodField()
    has_exact_position = serializers.SerializerMethodField()
    is_international = serializers.BooleanField(read_only=True)
    # Same "hidden until approved" gate as CollectionPointSerializer's own
    # flyer_image -- lets the map popup offer a "view flyer" shortcut
    # without a second request for the point's full detail.
    flyer_image = serializers.SerializerMethodField()

    class Meta:
        model = CollectionPoint
        fields = [
            "id", "point_name", "contact_name", "contact_phone", "organization", "hours",
            "status", "wilaya", "wilaya_name", "country_code", "country_name", "is_international",
            "city", "precision_level", "display_latitude", "display_longitude", "has_exact_position", "flyer_image",
        ]

    def get_wilaya_name(self, obj):
        return obj.wilaya.name if obj.wilaya_id else None

    def get_has_exact_position(self, obj):
        return obj.precision_level == CollectionPoint.PRECISION_EXACT

    def get_flyer_image(self, obj):
        if not obj.flyer_image or obj.flyer_moderation_status != Need.MODERATION_APPROVED:
            return None
        request = self.context.get("request")
        url = obj.flyer_image.url
        return request.build_absolute_uri(url) if request else url

    def _country_centroid(self, obj):
        from core.geo import get_country_centroid

        return get_country_centroid(obj.country_code, obj.country_name)

    def get_display_latitude(self, obj):
        if obj.latitude is not None:
            return obj.latitude
        if obj.wilaya_id is not None:
            return obj.wilaya.centroid_latitude
        if obj.country_code:
            # PRECISION_COUNTRY (flyer-extraction pipeline only -- the
            # manual international form always requires real GPS) has no
            # coordinates of its own at all; fall back to the country's own
            # centroid purely so it's visible on the map somewhere. Several
            # points in the same country land on this exact same position
            # and cluster into one bubble (InternationalCollectionPoints.jsx),
            # same as the existing city-level clustering.
            centroid = self._country_centroid(obj)
            return centroid[0] if centroid else None
        return None

    def get_display_longitude(self, obj):
        if obj.longitude is not None:
            return obj.longitude
        if obj.wilaya_id is not None:
            return obj.wilaya.centroid_longitude
        if obj.country_code:
            centroid = self._country_centroid(obj)
            return centroid[1] if centroid else None
        return None


class CollectionPointCloseSerializer(serializers.Serializer):
    """Either `code` (if the creator set a recovery_code) or the
    contact_name+contact_phone fallback must be provided -- see the view,
    which tries the code first when present. All optional at the field
    level since contact_name/contact_phone are themselves optional on the
    model now; matches_creator/matches_code below reject a blank/blank
    "match" either way."""

    code = serializers.CharField(required=False, allow_blank=True)
    contact_name = serializers.CharField(required=False, allow_blank=True)
    contact_phone = serializers.CharField(required=False, allow_blank=True)


# ---------------------------------------------------------------------------
# Flyer extraction pipeline: create one or more CollectionPoints from a photo
# ---------------------------------------------------------------------------

class FlyerSubmissionCreateSerializer(serializers.ModelSerializer):
    class Meta:
        model = FlyerSubmission
        fields = ["flyer_image", "submitter_name", "submitter_phone"]


class ExtractedCollectionPointSerializer(serializers.ModelSerializer):
    wilaya_name = serializers.CharField(source="wilaya.name", read_only=True)
    duplicate_of_name = serializers.CharField(source="duplicate_of.point_name", read_only=True)
    is_published = serializers.BooleanField(source="published_point_id", read_only=True)

    class Meta:
        model = ExtractedCollectionPoint
        fields = [
            "id", "point_name", "organization", "wilaya", "wilaya_name", "country_code", "country_name",
            "city", "location_description", "precision_level", "hours", "description", "accepted_donations",
            "contact_name", "contact_phone", "other_phones", "facebook_url", "tiktok_url", "instagram_url",
            "duplicate_of", "duplicate_of_name", "published_point", "is_published",
        ]


class FlyerSubmissionStatusSerializer(serializers.ModelSerializer):
    """Returned right after upload (the extraction call runs synchronously
    within that same request) and from a status lookup by access_token.
    Never exposes llm_raw_response (internal debugging only)."""

    extracted_points = ExtractedCollectionPointSerializer(many=True, read_only=True)

    class Meta:
        model = FlyerSubmission
        fields = [
            "id", "access_token", "status", "rejection_reason", "organization_common",
            "created_at", "extracted_points",
        ]
