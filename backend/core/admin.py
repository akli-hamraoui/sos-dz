from django.conf import settings
from django.contrib import admin
from django.utils import timezone
from django.utils.html import format_html
from django.utils.safestring import mark_safe

from core.models import (
    AdminContactPhone,
    AppConfiguration,
    AuditLog,
    BugReportProxy,
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
    RecoveryRequestProxy,
    SupportRequest,
    TranslationOverride,
    Wilaya,
)

# "View site" (top-right of every admin page) must open the real,
# maintained, fr/en/ar React frontend -- not this backend's own "/"
# (there is none worth visiting; see config/urls.py).
admin.site.site_url = settings.FRONTEND_URL

# Static button HTML, no dynamic value inside it at all (the value to copy
# is read from the DOM at click time via previousElementSibling, see
# copyable_token_field below) -- deliberately not run through format_html,
# which would otherwise need every literal '{'/'}' in this inline JS
# doubled just to survive its str.format() call.
_COPY_ICON_BUTTON = mark_safe(
    '<button type="button" title="Copy" style="cursor:pointer;border:1px solid #ccc;'
    'background:#fff;border-radius:4px;padding:3px 6px;line-height:1;vertical-align:middle;'
    'display:inline-flex;align-items:center;margin-inline-start:8px;" '
    "onclick=\"var b=this;navigator.clipboard.writeText(b.previousElementSibling.textContent)"
    ".then(function(){var o=b.innerHTML;b.innerHTML='&#10003;';"
    "setTimeout(function(){b.innerHTML=o;},1500);});\">"
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" '
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
    '<rect x="9" y="9" width="11" height="11" rx="2"></rect>'
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'
    "</svg></button>"
)


def copyable_token_field(value):
    """A read-only access_token value with an inline copy-icon button next
    to it, for Django Admin only -- lets an admin copy-paste it straight
    into a support reply (see core/audit's "second recovery path": a
    creator who lost their token can be handed a fresh one this way)
    instead of manually selecting the plain text."""
    if not value:
        return "—"
    code_html = format_html('<code style="user-select:all;">{}</code>', value)
    return code_html + _COPY_ICON_BUTTON


@admin.register(Wilaya)
class WilayaAdmin(admin.ModelAdmin):
    list_display = ["code", "name", "centroid_latitude", "centroid_longitude"]
    search_fields = ["name", "code"]


@admin.register(DisasterType)
class DisasterTypeAdmin(admin.ModelAdmin):
    list_display = ["name", "icon"]


def anonymize_campaign_listings(modeladmin, request, queryset):
    """Bulk action: deliberate, explicit -- NOT an automatic side effect of
    setting a campaign to 'stopped'."""
    count = 0
    for campaign in queryset:
        for need in campaign.needs.filter(pii_obfuscated_at__isnull=True):
            need.anonymize(Need.OBFUSCATED_BY_ADMIN)
            count += 1
        for pickup in Pickup.objects.filter(need__campaign=campaign, pii_obfuscated_at__isnull=True):
            pickup.anonymize(Pickup.OBFUSCATED_BY_ADMIN)
            count += 1
    AuditLog.objects.create(
        admin_user=request.user,
        action="bulk anonymized campaign listings",
        target_description=f"{count} listing(s) across {queryset.count()} campaign(s)",
    )
    modeladmin.message_user(request, f"Anonymized {count} listing(s).")


anonymize_campaign_listings.short_description = "Anonymize all personal data for this campaign"


@admin.register(Campaign)
class CampaignAdmin(admin.ModelAdmin):
    list_display = ["campaign_name", "disaster_type", "status", "created_at", "status_changed_at"]
    filter_horizontal = ["authorized_wilayas"]
    list_filter = ["status"]
    actions = [anonymize_campaign_listings]

    def save_model(self, request, obj, form, change):
        if change:
            previous = Campaign.objects.get(pk=obj.pk)
            if previous.status != obj.status:
                AuditLog.objects.create(
                    admin_user=request.user,
                    action=f"changed campaign status {previous.status} -> {obj.status}",
                    target_description=obj.campaign_name,
                )
        super().save_model(request, obj, form, change)


def anonymize_selected(modeladmin, request, queryset):
    actor_field = Need.OBFUSCATED_BY_ADMIN
    count = 0
    for obj in queryset:
        if not obj.is_anonymized:
            obj.anonymize(actor_field)
            AuditLog.objects.create(
                admin_user=request.user,
                action="anonymized listing",
                target_description=str(obj),
            )
            count += 1
    modeladmin.message_user(request, f"Anonymized {count} listing(s).")


anonymize_selected.short_description = "Anonymize this listing"


class PickupInline(admin.TabularInline):
    model = Pickup
    extra = 0
    fields = ["responder_type", "responder_name", "status", "created_at"]
    readonly_fields = ["created_at"]
    show_change_link = True


def approve_video(modeladmin, request, queryset):
    count = queryset.update(video_moderation_status=Need.MODERATION_APPROVED, video_moderated_by=Need.MODERATED_BY_ADMIN)
    AuditLog.objects.create(admin_user=request.user, action="approved video", target_description=f"{count} need(s)")
    modeladmin.message_user(request, f"Approved video on {count} need(s).")


approve_video.short_description = "Approve video (pending review queue)"


def reject_video(modeladmin, request, queryset):
    count = queryset.update(video_moderation_status=Need.MODERATION_REJECTED, video_moderated_by=Need.MODERATED_BY_ADMIN)
    AuditLog.objects.create(admin_user=request.user, action="rejected video", target_description=f"{count} need(s)")
    modeladmin.message_user(request, f"Rejected video on {count} need(s).")


reject_video.short_description = "Reject video (pending review queue)"


@admin.register(Need)
class NeedAdmin(admin.ModelAdmin):
    list_display = ["title", "wilaya", "urgency", "overall_status", "campaign", "video_moderation_status", "video_moderated_by", "is_anonymized_display", "created_at"]
    # video_moderation_status is filterable here specifically so "pending"
    # doubles as the video review queue -- filter to it, select the
    # need(s), then use the approve/reject actions below. Photos have
    # their own equivalent queue on DamagePhotoAdmin/DeliveryPhotoAdmin.
    list_filter = ["urgency", "overall_status", "wilaya", "campaign", "video_moderation_status"]
    search_fields = ["title", "contact_name", "contact_phone"]
    readonly_fields = ["access_token_copy", "location_viewer_share_token", "covered_quantity", "overall_status", "edit_history", "pii_obfuscated_at", "obfuscated_by"]
    actions = [anonymize_selected, approve_video, reject_video]
    inlines = [PickupInline]

    @admin.display(description="Access token")
    def access_token_copy(self, obj):
        return copyable_token_field(obj.access_token)

    def is_anonymized_display(self, obj):
        return obj.is_anonymized
    is_anonymized_display.boolean = True
    is_anonymized_display.short_description = "Anonymized"


@admin.register(Pickup)
class PickupAdmin(admin.ModelAdmin):
    list_display = ["id", "need", "collection_point", "responder_type", "responder_name", "status", "is_anonymized_display", "created_at"]
    list_filter = ["status", "responder_type"]
    search_fields = ["responder_name", "responder_phone"]
    readonly_fields = ["access_token_copy", "pii_obfuscated_at", "obfuscated_by"]
    actions = [anonymize_selected]

    @admin.display(description="Access token")
    def access_token_copy(self, obj):
        return copyable_token_field(obj.access_token)

    def is_anonymized_display(self, obj):
        return obj.is_anonymized
    is_anonymized_display.boolean = True
    is_anonymized_display.short_description = "Anonymized"


@admin.register(ProgressUpdate)
class ProgressUpdateAdmin(admin.ModelAdmin):
    list_display = ["pickup", "timestamp", "free_text"]


@admin.register(LocationPing)
class LocationPingAdmin(admin.ModelAdmin):
    list_display = ["pickup", "latitude", "longitude", "recorded_at"]


class AdminContactPhoneInline(admin.TabularInline):
    model = AdminContactPhone
    extra = 1
    max_num = 5


@admin.register(AppConfiguration)
class AppConfigurationAdmin(admin.ModelAdmin):
    list_display = ["mode", "media_moderation_active", "geo_restrict_writes_to_algeria", "enforce_video_duration_check"]
    inlines = [AdminContactPhoneInline]

    def has_add_permission(self, request):
        return not AppConfiguration.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False


class SupportRequestQueueAdmin(admin.ModelAdmin):
    """Shared behavior for the two category-filtered proxy admins below --
    each is a queue of SupportRequest rows, pre-scoped to one category, so
    an admin doesn't have to remember to apply that filter by hand. Rows
    are never created here (the public /support and /report-bug forms are
    the only intended source), but status can be edited (e.g. marking one
    as processed after following up) and the change form doubles as the
    "details" view."""

    list_display = ["requester_phone", "requester_email", "related_listing_description", "status", "created_at"]
    list_filter = ["status"]
    search_fields = ["message", "requester_phone", "requester_email", "related_listing_description"]
    readonly_fields = ["category", "requester_phone", "requester_email", "related_listing_description", "message", "created_at"]

    def has_add_permission(self, request):
        return False


@admin.register(BugReportProxy)
class BugReportAdmin(SupportRequestQueueAdmin):
    def get_queryset(self, request):
        return super().get_queryset(request).filter(category=SupportRequest.CATEGORY_BUG)


@admin.register(RecoveryRequestProxy)
class RecoveryRequestAdmin(SupportRequestQueueAdmin):
    def get_queryset(self, request):
        return super().get_queryset(request).filter(category=SupportRequest.CATEGORY_GENERAL)


@admin.register(TranslationOverride)
class TranslationOverrideAdmin(admin.ModelAdmin):
    list_display = ["key", "locale", "value"]
    list_filter = ["locale"]
    search_fields = ["key", "value"]


@admin.register(AuditLog)
class AuditLogAdmin(admin.ModelAdmin):
    list_display = ["created_at", "admin_user", "action", "target_description"]
    list_filter = ["action"]
    readonly_fields = [f.name for f in AuditLog._meta.fields]

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


# ---------------------------------------------------------------------------
# Moderation and report queues (Wave 3)
# ---------------------------------------------------------------------------

def approve_media(modeladmin, request, queryset):
    count = queryset.update(moderation_status=Need.MODERATION_APPROVED, moderated_by=Need.MODERATED_BY_ADMIN)
    AuditLog.objects.create(admin_user=request.user, action="approved media", target_description=f"{count} item(s)")
    modeladmin.message_user(request, f"Approved {count} item(s).")


approve_media.short_description = "Approve selected media"


def reject_media(modeladmin, request, queryset):
    count = queryset.update(moderation_status=Need.MODERATION_REJECTED, moderated_by=Need.MODERATED_BY_ADMIN)
    AuditLog.objects.create(admin_user=request.user, action="rejected media", target_description=f"{count} item(s)")
    modeladmin.message_user(request, f"Rejected {count} item(s).")


reject_media.short_description = "Reject selected media"


@admin.register(DamagePhoto)
class DamagePhotoAdmin(admin.ModelAdmin):
    list_display = ["id", "need", "moderation_status", "moderated_by", "created_at"]
    list_filter = ["moderation_status"]  # filter to "pending" for the review queue
    actions = [approve_media, reject_media]


@admin.register(DeliveryPhoto)
class DeliveryPhotoAdmin(admin.ModelAdmin):
    list_display = ["id", "pickup", "moderation_status", "moderated_by", "created_at"]
    list_filter = ["moderation_status"]
    actions = [approve_media, reject_media]


def process_duplicate_merge(modeladmin, request, queryset):
    """Admin decides the reported need was indeed a duplicate: cancel it,
    pointing people to the reference need instead."""
    count = 0
    for report in queryset.filter(status=DuplicateReport.STATUS_PENDING):
        need = report.reported_need
        need.is_cancelled = True
        need.cancellation_reason = f"Merged as duplicate of Need #{report.reference_need_id}"
        need.save()
        need.recompute_status()
        report.status = DuplicateReport.STATUS_PROCESSED
        report.save(update_fields=["status"])
        count += 1
    AuditLog.objects.create(admin_user=request.user, action="processed duplicate report (merged)", target_description=f"{count} report(s)")
    modeladmin.message_user(request, f"Merged/cancelled {count} reported need(s).")


process_duplicate_merge.short_description = "Merge: cancel the reported need as a duplicate"


def dismiss_duplicate_report(modeladmin, request, queryset):
    count = queryset.update(status=DuplicateReport.STATUS_PROCESSED)
    AuditLog.objects.create(admin_user=request.user, action="dismissed duplicate report", target_description=f"{count} report(s)")
    modeladmin.message_user(request, f"Dismissed {count} report(s).")


dismiss_duplicate_report.short_description = "Dismiss (not a duplicate)"


@admin.register(DuplicateReport)
class DuplicateReportAdmin(admin.ModelAdmin):
    list_display = ["id", "reported_need", "reference_need", "status", "reported_at"]
    list_filter = ["status"]
    actions = [process_duplicate_merge, dismiss_duplicate_report]


def restore_content(modeladmin, request, queryset):
    count = 0
    for report in queryset.filter(status=ContentReport.STATUS_PENDING):
        media_obj = report.get_media_object()
        if media_obj is not None:
            if isinstance(media_obj, Need):
                field, by_field = "video_moderation_status", "video_moderated_by"
            elif isinstance(media_obj, CollectionPoint):
                field, by_field = "flyer_moderation_status", "flyer_moderated_by"
            else:
                field, by_field = "moderation_status", "moderated_by"
            setattr(media_obj, field, Need.MODERATION_APPROVED)
            setattr(media_obj, by_field, Need.MODERATED_BY_ADMIN)
            media_obj.save(update_fields=[field, by_field])
        report.status = ContentReport.STATUS_PROCESSED
        report.save(update_fields=["status"])
        count += 1
    AuditLog.objects.create(admin_user=request.user, action="restored reported content", target_description=f"{count} report(s)")
    modeladmin.message_user(request, f"Restored {count} item(s).")


restore_content.short_description = "Restore (report was unfounded)"


def confirm_content_rejection(modeladmin, request, queryset):
    count = 0
    for report in queryset.filter(status=ContentReport.STATUS_PENDING):
        media_obj = report.get_media_object()
        if media_obj is not None:
            if isinstance(media_obj, Need):
                field, by_field = "video_moderation_status", "video_moderated_by"
            elif isinstance(media_obj, CollectionPoint):
                field, by_field = "flyer_moderation_status", "flyer_moderated_by"
            else:
                field, by_field = "moderation_status", "moderated_by"
            setattr(media_obj, field, Need.MODERATION_REJECTED)
            setattr(media_obj, by_field, Need.MODERATED_BY_ADMIN)
            media_obj.save(update_fields=[field, by_field])
        report.status = ContentReport.STATUS_PROCESSED
        report.save(update_fields=["status"])
        count += 1
    AuditLog.objects.create(admin_user=request.user, action="confirmed content report rejection", target_description=f"{count} report(s)")
    modeladmin.message_user(request, f"Kept {count} item(s) rejected.")


confirm_content_rejection.short_description = "Confirm rejection (report was valid)"


@admin.register(ContentReport)
class ContentReportAdmin(admin.ModelAdmin):
    list_display = ["id", "media_type", "media_id", "reason", "status", "reported_at"]
    list_filter = ["status", "media_type"]
    actions = [restore_content, confirm_content_rejection]


# ---------------------------------------------------------------------------
# Community: collection points and comments (Wave 4)
# ---------------------------------------------------------------------------

def approve_flyer(modeladmin, request, queryset):
    count = queryset.update(flyer_moderation_status=Need.MODERATION_APPROVED, flyer_moderated_by=Need.MODERATED_BY_ADMIN)
    AuditLog.objects.create(admin_user=request.user, action="approved flyer", target_description=f"{count} collection point(s)")
    modeladmin.message_user(request, f"Approved flyer on {count} collection point(s).")


approve_flyer.short_description = "Approve flyer (pending review queue)"


def reject_flyer(modeladmin, request, queryset):
    count = queryset.update(flyer_moderation_status=Need.MODERATION_REJECTED, flyer_moderated_by=Need.MODERATED_BY_ADMIN)
    AuditLog.objects.create(admin_user=request.user, action="rejected flyer", target_description=f"{count} collection point(s)")
    modeladmin.message_user(request, f"Rejected flyer on {count} collection point(s).")


reject_flyer.short_description = "Reject flyer (pending review queue)"


@admin.register(CollectionPoint)
class CollectionPointAdmin(admin.ModelAdmin):
    list_display = ["point_name", "wilaya", "country_name", "contact_name", "status", "flyer_moderation_status", "created_at"]
    list_filter = ["status", "wilaya", "country_code", "flyer_moderation_status"]
    search_fields = ["point_name", "contact_name", "contact_phone", "country_name"]
    # access_token isn't editable=False in a ModelForm doesn't show it at
    # all by default -- listed here (same as NeedAdmin/PickupAdmin) so an
    # admin can actually read it here and relay it to a creator who lost
    # access and contacted support (core.models.SupportRequest,
    # category=general / "coordonnées oubliées"), as a second recovery path
    # alongside the self-service name+phone/code one.
    readonly_fields = ["access_token_copy"]
    actions = [approve_flyer, reject_flyer]

    @admin.display(description="Access token")
    def access_token_copy(self, obj):
        return copyable_token_field(obj.access_token)


@admin.register(Comment)
class CommentAdmin(admin.ModelAdmin):
    list_display = ["id", "author_name", "need", "collection_point", "pickup", "parent_comment", "confirmation_count", "created_at"]
    list_filter = ["category"]
    search_fields = ["author_name", "text"]

    def delete_model(self, request, obj):
        AuditLog.objects.create(admin_user=request.user, action="deleted comment", target_description=str(obj))
        super().delete_model(request, obj)

    def delete_queryset(self, request, queryset):
        AuditLog.objects.create(admin_user=request.user, action="deleted comment (bulk)", target_description=f"{queryset.count()} comment(s)")
        super().delete_queryset(request, queryset)
