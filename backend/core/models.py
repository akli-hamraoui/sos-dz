import secrets
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone


def generate_token():
    """32-char random access token. Not hashed: it's a temporary access key
    scoped to one resource, not a password (see spec, AUTHENTICATION MODEL)."""
    return secrets.token_urlsafe(24)[:32]


# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------

class Wilaya(models.Model):
    """Fixed reference table: the 58 wilayas of Algeria. Closed list, no
    free text allowed elsewhere in the app."""

    code = models.CharField(max_length=2, unique=True)
    name = models.CharField(max_length=100, unique=True)
    centroid_latitude = models.FloatField(null=True, blank=True)
    centroid_longitude = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ["code"]

    def __str__(self):
        return self.name


class DisasterType(models.Model):
    """Admin-only creation."""

    name = models.CharField(max_length=100)
    icon = models.CharField(max_length=100, blank=True, help_text="Icon name/emoji shown in the UI")

    def __str__(self):
        return self.name


class Campaign(models.Model):
    STATUS_ACTIVE = "active"
    STATUS_PAUSED = "paused"
    STATUS_STOPPED = "stopped"
    STATUS_CHOICES = [
        (STATUS_ACTIVE, "Active"),
        (STATUS_PAUSED, "Paused"),
        (STATUS_STOPPED, "Stopped"),
    ]

    campaign_name = models.CharField(max_length=200)
    disaster_type = models.ForeignKey(DisasterType, null=True, blank=True, on_delete=models.SET_NULL)
    authorized_wilayas = models.ManyToManyField(Wilaya, related_name="campaigns", blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    created_at = models.DateTimeField(auto_now_add=True)
    status_changed_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.campaign_name

    def save(self, *args, **kwargs):
        if self.pk is not None:
            previous = Campaign.objects.filter(pk=self.pk).first()
            if previous and previous.status != self.status:
                self.status_changed_at = timezone.now()
        super().save(*args, **kwargs)


class AppConfiguration(models.Model):
    """Singleton model: use AppConfiguration.get_solo()."""

    MODE_NORMAL = "normal"
    MODE_READ_ONLY = "read_only"
    MODE_CHOICES = [(MODE_NORMAL, "Normal"), (MODE_READ_ONLY, "Read-only")]

    mode = models.CharField(max_length=20, choices=MODE_CHOICES, default=MODE_NORMAL)
    media_moderation_active = models.BooleanField(default=True)
    geo_restrict_writes_to_algeria = models.BooleanField(
        default=True,
        help_text=(
            "When enabled, only requests whose IP geolocates to Algeria may create/edit "
            "listings (admins always bypass this). Turn off if this blocks legitimate "
            "diaspora volunteers coordinating from abroad."
        ),
    )
    # Phone numbers are a related model (AdminContactPhone, up to 5 --
    # enforced by AdminContactPhoneInline's max_num in admin.py) rather
    # than a single field, so an admin can list more than one contact
    # number from the ordinary Django Admin "add another row" UI. Email
    # stays a single field since only phone needed this.
    admin_contact_email = models.EmailField(
        max_length=254, blank=True, help_text="Shown site-wide (footer) when set. Leave blank to hide."
    )

    class Meta:
        verbose_name = "App configuration"
        verbose_name_plural = "App configuration"

    def save(self, *args, **kwargs):
        self.pk = 1
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        pass

    @classmethod
    def get_solo(cls):
        obj, _ = cls.objects.get_or_create(pk=1)
        return obj

    def __str__(self):
        return "App configuration"


class AdminContactPhone(models.Model):
    """Up to 5 per AppConfiguration (enforced in Django Admin, see
    AdminContactPhoneInline) -- each shown as its own link in the site
    footer."""

    config = models.ForeignKey(AppConfiguration, on_delete=models.CASCADE, related_name="contact_phones")
    phone = models.CharField(max_length=30)
    label = models.CharField(max_length=50, blank=True, help_text='Optional, e.g. "WhatsApp" or a wilaya name')

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return f"{self.phone} ({self.label})" if self.label else self.phone


# ---------------------------------------------------------------------------
# Identity / anonymization shared behaviour
# ---------------------------------------------------------------------------

class IdentityListingMixin(models.Model):
    """Shared token-auth + PII anonymization behaviour for Need and Pickup.

    Concrete subclasses provide the actual identity field names (they differ:
    contact_* on Need, responder_* on Pickup) via `identity_fields()` and
    `anonymize_identity_fields()`.
    """

    OBFUSCATED_BY_ADMIN = "admin"
    OBFUSCATED_BY_CREATOR = "creator"
    OBFUSCATED_BY_RESPONDER = "responder"
    OBFUSCATED_BY_CHOICES = [
        (OBFUSCATED_BY_ADMIN, "Admin"),
        (OBFUSCATED_BY_CREATOR, "Creator"),
        (OBFUSCATED_BY_RESPONDER, "Responder"),
    ]

    access_token = models.CharField(max_length=32, unique=True, default=generate_token, editable=False)
    # Optional, user-chosen memorable code offered at creation time -- an
    # easier way to recover access from a new device than the name+phone
    # identity match below (which stays as the fallback for anyone who
    # skipped or forgot the code). Blank means "no code set".
    recovery_code = models.CharField(max_length=20, blank=True)
    pii_obfuscated_at = models.DateTimeField(null=True, blank=True)
    obfuscated_by = models.CharField(max_length=20, choices=OBFUSCATED_BY_CHOICES, null=True, blank=True)

    class Meta:
        abstract = True

    @property
    def is_anonymized(self):
        return self.pii_obfuscated_at is not None

    def matches_identity(self, name, phone):
        if self.is_anonymized:
            return False
        f = self.identity_fields()
        return (
            (f["name"] or "").strip().lower() == (name or "").strip().lower()
            and (f["phone"] or "").strip() == (phone or "").strip()
        )

    def matches_code(self, code):
        if self.is_anonymized or not self.recovery_code:
            return False
        return self.recovery_code.strip() == (code or "").strip()

    def regenerate_token(self):
        self.access_token = generate_token()
        self.save(update_fields=["access_token"])
        return self.access_token

    def anonymize(self, actor):
        """actor: one of OBFUSCATED_BY_* choices."""
        self.anonymize_identity_fields()
        self.pii_obfuscated_at = timezone.now()
        self.obfuscated_by = actor
        self.save()


# ---------------------------------------------------------------------------
# Need
# ---------------------------------------------------------------------------

class Need(IdentityListingMixin, models.Model):
    URGENCY_LOW = "low"
    URGENCY_MEDIUM = "medium"
    URGENCY_CRITICAL = "critical"
    URGENCY_CHOICES = [
        (URGENCY_LOW, "Low"),
        (URGENCY_MEDIUM, "Medium"),
        (URGENCY_CRITICAL, "Critical"),
    ]

    POSITION_EXACT = "exact"
    POSITION_APPROXIMATE = "approximate"
    POSITION_CHOICES = [(POSITION_EXACT, "Exact"), (POSITION_APPROXIMATE, "Approximate (no exact GPS position)")]

    STATUS_OPEN = "open"
    STATUS_PARTIALLY_COVERED = "partially_covered"
    STATUS_COVERED = "covered"
    STATUS_CANCELLED = "cancelled"
    STATUS_CHOICES = [
        (STATUS_OPEN, "Open"),
        (STATUS_PARTIALLY_COVERED, "Partially covered"),
        (STATUS_COVERED, "Covered"),
        (STATUS_CANCELLED, "Cancelled"),
    ]

    campaign = models.ForeignKey(Campaign, on_delete=models.PROTECT, related_name="needs")
    disaster_type = models.ForeignKey(DisasterType, null=True, blank=True, on_delete=models.SET_NULL)

    title = models.CharField(max_length=200)
    # Deliberately free text ("about 50 families", "3 blankets and some water"),
    # not a number: real-world need quantities are often informal/uncertain
    # at creation time, and forcing a strict count would misrepresent that.
    # This means it cannot be compared numerically against covered_quantity
    # below -- see that field's help_text.
    estimated_quantity = models.CharField(max_length=200, blank=True)
    urgency = models.CharField(max_length=20, choices=URGENCY_CHOICES, default=URGENCY_MEDIUM)

    wilaya = models.ForeignKey(Wilaya, on_delete=models.PROTECT, related_name="needs")
    commune = models.CharField(max_length=200, blank=True)
    # Not required at the field level -- NeedCreateSerializer enforces "at
    # least one of description/voice/video" instead, since any one of the
    # three can carry the actual content of the request.
    location_description = models.TextField(blank=True)
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    position_accuracy = models.CharField(max_length=20, choices=POSITION_CHOICES, default=POSITION_APPROXIMATE)

    contact_name = models.CharField(max_length=200)
    contact_phone = models.CharField(max_length=30)
    contact_email = models.EmailField(blank=True)
    organization_or_person_name = models.CharField(max_length=200, blank=True)

    # Media (Wave 2): voice and video are independent and combinable (along
    # with the text description above) rather than a single either/or
    # choice -- someone reporting in an emergency can attach as many of the
    # three as they're able to, as long as at least one is present (see
    # NeedCreateSerializer.validate).
    voice_file = models.FileField(upload_to="need_media/", null=True, blank=True)
    video_file = models.FileField(upload_to="need_media/", null=True, blank=True)

    MODERATION_PENDING, MODERATION_APPROVED, MODERATION_REJECTED = "pending", "approved", "rejected"
    MODERATION_CHOICES = [
        (MODERATION_PENDING, "Pending"),
        (MODERATION_APPROVED, "Approved"),
        (MODERATION_REJECTED, "Rejected"),
    ]
    # Voice has no visual content for NSFWJS to score, so only video is ever
    # actually moderated -- there's no equivalent moderation field for voice.
    video_moderation_status = models.CharField(max_length=10, choices=MODERATION_CHOICES, default=MODERATION_APPROVED)

    is_cancelled = models.BooleanField(default=False)
    cancellation_reason = models.CharField(max_length=500, blank=True)

    # NOT a coverage ratio against estimated_quantity above -- that field is
    # free text (e.g. "about 50 families") and has no reliable numeric form,
    # so no "X of Y covered" comparison is computable or attempted anywhere
    # in this codebase. This is purely an internal counter (how many active
    # pickups this Need has) used only to derive overall_status's 3-state
    # label (open / partially_covered / covered, see recompute_status
    # below) -- it is not itself surfaced to end users as a number or
    # progress bar. If a real numeric coverage feature is wanted later, it
    # needs estimated_quantity to become a real numeric field first (a
    # product decision, since it would mean rejecting/reformatting informal
    # quantity descriptions at creation time).
    covered_quantity = models.PositiveIntegerField(default=0, help_text="Count of active (en_route/delivered) pickups. Internal counter for overall_status only -- not a ratio against estimated_quantity.")
    overall_status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_OPEN)

    location_viewer_share_token = models.CharField(max_length=32, unique=True, default=generate_token, editable=False)

    created_at = models.DateTimeField(auto_now_add=True)
    last_modified_at = models.DateTimeField(auto_now=True)
    edit_history = models.JSONField(default=list, blank=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.title

    def identity_fields(self):
        return {
            "name": self.contact_name,
            "phone": self.contact_phone,
        }

    def anonymize_identity_fields(self):
        self.contact_name = "Anonymized"
        self.contact_phone = ""
        self.contact_email = ""
        self.organization_or_person_name = ""

    def record_edit(self):
        self.edit_history = (self.edit_history or []) + [timezone.now().isoformat()]

    def regenerate_share_token(self):
        self.location_viewer_share_token = generate_token()
        self.save(update_fields=["location_viewer_share_token"])
        return self.location_viewer_share_token

    def recompute_status(self, save=True):
        if self.is_cancelled:
            self.overall_status = self.STATUS_CANCELLED
        else:
            active_pickups = self.pickups.exclude(status=Pickup.STATUS_CANCELLED)
            self.covered_quantity = active_pickups.count()
            has_delivered = active_pickups.filter(status=Pickup.STATUS_DELIVERED).exists()
            still_en_route = active_pickups.filter(status=Pickup.STATUS_EN_ROUTE).exists()
            if self.covered_quantity == 0:
                self.overall_status = self.STATUS_OPEN
            elif has_delivered and not still_en_route:
                self.overall_status = self.STATUS_COVERED
            else:
                self.overall_status = self.STATUS_PARTIALLY_COVERED
        if save:
            self.save(update_fields=["overall_status", "covered_quantity"])


class DamagePhoto(models.Model):
    """Up to 3 live-captured photos per Need (Wave 2). Each photo is
    moderated independently (Wave 3) -- one photo being flagged must not
    hide the other two."""

    need = models.ForeignKey(Need, on_delete=models.CASCADE, related_name="damage_photos")
    image = models.ImageField(upload_to="damage_photos/")
    moderation_status = models.CharField(max_length=10, choices=Need.MODERATION_CHOICES, default=Need.MODERATION_PENDING)
    created_at = models.DateTimeField(auto_now_add=True)


# ---------------------------------------------------------------------------
# Pickup
# ---------------------------------------------------------------------------

class Pickup(IdentityListingMixin, models.Model):
    RESPONDER_INDIVIDUAL = "individual_volunteer"
    RESPONDER_ORGANIZATION = "organization"
    RESPONDER_TRUCK = "collective_truck"
    RESPONDER_TYPE_CHOICES = [
        (RESPONDER_INDIVIDUAL, "Individual volunteer"),
        (RESPONDER_ORGANIZATION, "Organization"),
        (RESPONDER_TRUCK, "Collective truck"),
    ]

    STATUS_EN_ROUTE = "en_route"
    STATUS_DELIVERED = "delivered"
    STATUS_CANCELLED = "cancelled"
    STATUS_CHOICES = [
        (STATUS_EN_ROUTE, "En route"),
        (STATUS_DELIVERED, "Delivered"),
        (STATUS_CANCELLED, "Cancelled"),
    ]

    need = models.ForeignKey(Need, on_delete=models.CASCADE, related_name="pickups")
    responder_type = models.CharField(max_length=30, choices=RESPONDER_TYPE_CHOICES)
    responder_name = models.CharField(max_length=200)
    responder_phone = models.CharField(max_length=30)
    responder_email = models.EmailField(blank=True)
    organization_or_person_name = models.CharField(max_length=200, blank=True)
    content_brought = models.TextField(blank=True)

    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_EN_ROUTE)
    cancellation_reason = models.CharField(max_length=500, blank=True)

    location_sharing_active = models.BooleanField(default=False)

    pickup_date = models.DateTimeField(auto_now_add=True)
    actual_delivery_date = models.DateTimeField(null=True, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"Pickup #{self.pk} for {self.need_id}"

    def identity_fields(self):
        return {
            "name": self.responder_name,
            "phone": self.responder_phone,
        }

    def anonymize_identity_fields(self):
        self.responder_name = "Anonymized"
        self.responder_phone = ""
        self.responder_email = ""
        self.organization_or_person_name = ""

    @property
    def needs_verification(self):
        """A pickup with no update in 24h is flagged 'to verify' (never deleted)."""
        if self.status != self.STATUS_EN_ROUTE:
            return False
        last_update = self.progress_updates.order_by("-timestamp").first()
        reference_time = last_update.timestamp if last_update else self.created_at
        return timezone.now() - reference_time > timedelta(hours=24)

    def mark_delivered(self):
        self.status = self.STATUS_DELIVERED
        self.actual_delivery_date = timezone.now()
        self.save(update_fields=["status", "actual_delivery_date"])
        self.need.recompute_status()

    def save(self, *args, **kwargs):
        super().save(*args, **kwargs)


class DeliveryPhoto(models.Model):
    """Up to 3 live-captured proof-of-delivery photos per Pickup (Wave 2)."""

    pickup = models.ForeignKey(Pickup, on_delete=models.CASCADE, related_name="delivery_photos")
    image = models.ImageField(upload_to="delivery_photos/")
    moderation_status = models.CharField(max_length=10, choices=Need.MODERATION_CHOICES, default=Need.MODERATION_PENDING)
    created_at = models.DateTimeField(auto_now_add=True)


class ProgressUpdate(models.Model):
    """Public free-text timeline entry. Never restricted -- see spec MAP VIEW."""

    pickup = models.ForeignKey(Pickup, on_delete=models.CASCADE, related_name="progress_updates")
    free_text = models.TextField()
    timestamp = models.DateTimeField(auto_now_add=True)
    gps_latitude = models.FloatField(null=True, blank=True)
    gps_longitude = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ["timestamp"]


class LocationPing(models.Model):
    """Access-restricted live position trail for a Pickup. See spec MAP VIEW:
    visible only to the Need's creator, a valid share-link holder, or admin."""

    pickup = models.ForeignKey(Pickup, on_delete=models.CASCADE, related_name="location_pings")
    latitude = models.FloatField()
    longitude = models.FloatField()
    recorded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["recorded_at"]


# ---------------------------------------------------------------------------
# Duplicate / content reporting (Wave 3)
# ---------------------------------------------------------------------------

class DuplicateReport(models.Model):
    STATUS_PENDING, STATUS_PROCESSED = "pending", "processed"
    STATUS_CHOICES = [(STATUS_PENDING, "Pending"), (STATUS_PROCESSED, "Processed")]

    reported_need = models.ForeignKey(Need, on_delete=models.CASCADE, related_name="duplicate_reports_against")
    reference_need = models.ForeignKey(Need, on_delete=models.CASCADE, related_name="duplicate_reports_as_reference")
    reporter_name = models.CharField(max_length=200)
    reporter_phone = models.CharField(max_length=30)
    reported_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PENDING)


class ContentReport(models.Model):
    MEDIA_NEED_FILE = "need_media_file"
    MEDIA_DAMAGE_PHOTO = "damage_photo"
    MEDIA_DELIVERY_PHOTO = "delivery_photo"
    MEDIA_TYPE_CHOICES = [
        (MEDIA_NEED_FILE, "Need media file (audio/video)"),
        (MEDIA_DAMAGE_PHOTO, "Damage photo"),
        (MEDIA_DELIVERY_PHOTO, "Delivery photo"),
    ]
    STATUS_PENDING, STATUS_PROCESSED = "pending", "processed"
    STATUS_CHOICES = [(STATUS_PENDING, "Pending"), (STATUS_PROCESSED, "Processed")]

    media_type = models.CharField(max_length=20, choices=MEDIA_TYPE_CHOICES)
    media_id = models.PositiveIntegerField()
    reporter_name = models.CharField(max_length=200)
    reporter_phone = models.CharField(max_length=30)
    reason = models.CharField(max_length=500)
    reported_at = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PENDING)

    def get_media_object(self):
        model = {
            self.MEDIA_NEED_FILE: Need,
            self.MEDIA_DAMAGE_PHOTO: DamagePhoto,
            self.MEDIA_DELIVERY_PHOTO: DeliveryPhoto,
        }[self.media_type]
        return model.objects.filter(pk=self.media_id).first()


# ---------------------------------------------------------------------------
# Support / audit
# ---------------------------------------------------------------------------

class SupportRequest(models.Model):
    STATUS_PENDING, STATUS_PROCESSED = "pending", "processed"
    STATUS_CHOICES = [(STATUS_PENDING, "Pending"), (STATUS_PROCESSED, "Processed")]

    CATEGORY_GENERAL, CATEGORY_BUG = "general", "bug"
    CATEGORY_CHOICES = [(CATEGORY_GENERAL, "General / contact"), (CATEGORY_BUG, "Bug report")]

    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES, default=CATEGORY_GENERAL)
    # Individually optional -- at least one is enforced in
    # SupportRequestSerializer.validate() so the admin always has some way
    # to follow up, without forcing a specific one of the two.
    requester_phone = models.CharField(max_length=30, blank=True)
    requester_email = models.EmailField(max_length=254, blank=True)
    related_listing_description = models.CharField(max_length=200, blank=True)
    message = models.TextField()
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PENDING)
    created_at = models.DateTimeField(auto_now_add=True)


# ---------------------------------------------------------------------------
# Community: collection points and comments (Wave 4)
# ---------------------------------------------------------------------------

class CollectionPoint(models.Model):
    STATUS_ACTIVE, STATUS_CLOSED = "active", "closed"
    STATUS_CHOICES = [(STATUS_ACTIVE, "Active"), (STATUS_CLOSED, "Closed")]

    wilaya = models.ForeignKey(Wilaya, on_delete=models.PROTECT, related_name="collection_points")
    point_name = models.CharField(max_length=200)
    contact_name = models.CharField(max_length=200)
    contact_phone = models.CharField(max_length=30)
    organization = models.CharField(max_length=200, blank=True)
    location_description = models.TextField()
    latitude = models.FloatField(null=True, blank=True)
    longitude = models.FloatField(null=True, blank=True)
    hours = models.CharField(max_length=200, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_ACTIVE)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return self.point_name

    def matches_creator(self, name, phone):
        """Loose name+phone match for self-service closing -- lighter than
        Need/Pickup's token+DOB scheme, per spec: collection points carry
        less edit/cancel sensitivity."""
        return (
            self.contact_name.strip().lower() == (name or "").strip().lower()
            and self.contact_phone.strip() == (phone or "").strip()
        )


class Comment(models.Model):
    """Usable on either a Need or a CollectionPoint (exactly one of the two
    FKs is set). One level of replies only -- parent_comment_id must itself
    have no parent."""

    CATEGORY_FIELD_INFO = "field_info"
    CATEGORY_CONTACT_INFO = "contact_info"
    CATEGORY_CONFIRMATION = "confirmation"
    CATEGORY_CHOICES = [
        (CATEGORY_FIELD_INFO, "Field info"),
        (CATEGORY_CONTACT_INFO, "Contact info"),
        (CATEGORY_CONFIRMATION, "Confirmation"),
    ]

    need = models.ForeignKey(Need, null=True, blank=True, on_delete=models.CASCADE, related_name="comments")
    collection_point = models.ForeignKey(CollectionPoint, null=True, blank=True, on_delete=models.CASCADE, related_name="comments")
    parent_comment = models.ForeignKey("self", null=True, blank=True, on_delete=models.CASCADE, related_name="replies")

    author_name = models.CharField(max_length=200)
    # Optional -- comment authoring only requires a name (see spec update);
    # kept for any legacy comment created back when it was required, and
    # still settable from Django Admin, but never serialized publicly (see
    # CommentSerializer). Deletion is authorized via owner_token below, not
    # by matching this.
    author_phone = models.CharField(max_length=30, blank=True)
    # Returned once, only in the create response (like Need/Pickup's
    # access_token) -- lets the author delete this specific comment later
    # without re-proving identity. Never included in any public read.
    owner_token = models.CharField(max_length=32, unique=True, default=generate_token, editable=False)
    text = models.TextField()
    category = models.CharField(max_length=20, choices=CATEGORY_CHOICES, blank=True)
    confirmation_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at"]

    def matches_owner_token(self, token):
        return bool(token) and self.owner_token == token


class AuditLog(models.Model):
    """Every admin moderation/override action, and anonymization events."""

    admin_user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)
    action = models.CharField(max_length=200)
    target_description = models.CharField(max_length=300, blank=True)
    reason = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        who = self.admin_user or "system"
        return f"{self.created_at:%Y-%m-%d %H:%M} - {who} - {self.action}"


class TranslationOverride(models.Model):
    """Lets an admin correct/adjust a piece of UI text from Django Admin
    without a code deploy. `key` is a dotted i18next key exactly as used in
    the frontend's t() calls (e.g. "home.tagline", "createNeed.name") --
    the frontend fetches all overrides at startup and merges them over the
    static locale JSON bundles (see /api/translations/), so an override
    for a key that doesn't exist in the static files has no effect."""

    LOCALE_CHOICES = [("fr", "Français"), ("en", "English"), ("ar", "العربية")]

    locale = models.CharField(max_length=5, choices=LOCALE_CHOICES)
    key = models.CharField(max_length=200, help_text='Dotted i18next key, e.g. "home.tagline"')
    value = models.TextField()

    class Meta:
        unique_together = [("locale", "key")]
        ordering = ["locale", "key"]

    def __str__(self):
        return f"[{self.locale}] {self.key}"
