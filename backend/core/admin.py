from django.contrib import admin
from django.utils import timezone

from core.models import (
    AppConfiguration,
    AuditLog,
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


@admin.register(Need)
class NeedAdmin(admin.ModelAdmin):
    list_display = ["title", "wilaya", "urgency", "overall_status", "campaign", "is_anonymized_display", "created_at"]
    list_filter = ["urgency", "overall_status", "wilaya", "campaign", "video_moderation_status"]
    search_fields = ["title", "contact_name", "contact_phone"]
    readonly_fields = ["access_token", "location_viewer_share_token", "covered_quantity", "overall_status", "edit_history", "pii_obfuscated_at", "obfuscated_by"]
    actions = [anonymize_selected]
    inlines = [PickupInline]

    def is_anonymized_display(self, obj):
        return obj.is_anonymized
    is_anonymized_display.boolean = True
    is_anonymized_display.short_description = "Anonymized"


@admin.register(Pickup)
class PickupAdmin(admin.ModelAdmin):
    list_display = ["id", "need", "responder_type", "responder_name", "status", "is_anonymized_display", "created_at"]
    list_filter = ["status", "responder_type"]
    search_fields = ["responder_name", "responder_phone"]
    readonly_fields = ["access_token", "pii_obfuscated_at", "obfuscated_by"]
    actions = [anonymize_selected]

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


@admin.register(AppConfiguration)
class AppConfigurationAdmin(admin.ModelAdmin):
    list_display = ["mode", "media_moderation_active", "geo_restrict_writes_to_algeria"]

    def has_add_permission(self, request):
        return not AppConfiguration.objects.exists()

    def has_delete_permission(self, request, obj=None):
        return False


@admin.register(SupportRequest)
class SupportRequestAdmin(admin.ModelAdmin):
    list_display = ["requester_phone", "status", "created_at"]
    list_filter = ["status"]


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
    count = queryset.update(moderation_status=Need.MODERATION_APPROVED)
    AuditLog.objects.create(admin_user=request.user, action="approved media", target_description=f"{count} item(s)")
    modeladmin.message_user(request, f"Approved {count} item(s).")


approve_media.short_description = "Approve selected media"


def reject_media(modeladmin, request, queryset):
    count = queryset.update(moderation_status=Need.MODERATION_REJECTED)
    AuditLog.objects.create(admin_user=request.user, action="rejected media", target_description=f"{count} item(s)")
    modeladmin.message_user(request, f"Rejected {count} item(s).")


reject_media.short_description = "Reject selected media"


@admin.register(DamagePhoto)
class DamagePhotoAdmin(admin.ModelAdmin):
    list_display = ["id", "need", "moderation_status", "created_at"]
    list_filter = ["moderation_status"]  # filter to "pending" for the review queue
    actions = [approve_media, reject_media]


@admin.register(DeliveryPhoto)
class DeliveryPhotoAdmin(admin.ModelAdmin):
    list_display = ["id", "pickup", "moderation_status", "created_at"]
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
            field = "video_moderation_status" if isinstance(media_obj, Need) else "moderation_status"
            setattr(media_obj, field, Need.MODERATION_APPROVED)
            media_obj.save(update_fields=[field])
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
            field = "video_moderation_status" if isinstance(media_obj, Need) else "moderation_status"
            setattr(media_obj, field, Need.MODERATION_REJECTED)
            media_obj.save(update_fields=[field])
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

@admin.register(CollectionPoint)
class CollectionPointAdmin(admin.ModelAdmin):
    list_display = ["point_name", "wilaya", "contact_name", "status", "created_at"]
    list_filter = ["status", "wilaya"]
    search_fields = ["point_name", "contact_name", "contact_phone"]


@admin.register(Comment)
class CommentAdmin(admin.ModelAdmin):
    list_display = ["id", "author_name", "need", "collection_point", "parent_comment", "confirmation_count", "created_at"]
    list_filter = ["category"]
    search_fields = ["author_name", "text"]

    def delete_model(self, request, obj):
        AuditLog.objects.create(admin_user=request.user, action="deleted comment", target_description=str(obj))
        super().delete_model(request, obj)

    def delete_queryset(self, request, queryset):
        AuditLog.objects.create(admin_user=request.user, action="deleted comment (bulk)", target_description=f"{queryset.count()} comment(s)")
        super().delete_queryset(request, queryset)
