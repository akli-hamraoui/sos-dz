from django.contrib import admin
from django.utils import timezone

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
    fields = ["responder_type", "responder_last_name", "status", "created_at"]
    readonly_fields = ["created_at"]
    show_change_link = True


@admin.register(Need)
class NeedAdmin(admin.ModelAdmin):
    list_display = ["title", "wilaya", "urgency", "overall_status", "campaign", "is_anonymized_display", "created_at"]
    list_filter = ["urgency", "overall_status", "wilaya", "campaign", "media_moderation_status"]
    search_fields = ["title", "contact_last_name", "contact_phone"]
    readonly_fields = ["access_token", "location_viewer_share_token", "covered_quantity", "overall_status", "edit_history", "pii_obfuscated_at", "obfuscated_by"]
    actions = [anonymize_selected]
    inlines = [PickupInline]

    def is_anonymized_display(self, obj):
        return obj.is_anonymized
    is_anonymized_display.boolean = True
    is_anonymized_display.short_description = "Anonymized"


@admin.register(Pickup)
class PickupAdmin(admin.ModelAdmin):
    list_display = ["id", "need", "responder_type", "responder_last_name", "status", "is_anonymized_display", "created_at"]
    list_filter = ["status", "responder_type"]
    search_fields = ["responder_last_name", "responder_phone"]
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
