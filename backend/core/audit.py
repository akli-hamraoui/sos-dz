import contextvars

from django.db import models
from django.utils import timezone

# Bound by RequestClientIPMiddleware for the lifetime of one request/response
# cycle -- lets AuditMixin.save() below know "which IP is doing this write"
# without threading a request object through every model/serializer/admin
# save() call site across the whole codebase. Falls back to None (no bound
# request -- a management command, a migration, a test creating rows
# directly via the ORM) rather than raising.
current_request_ip = contextvars.ContextVar("current_request_ip", default=None)

# Resolved once per request (RequestClientIPMiddleware, from the same IP as
# current_request_ip above) via core.geoip.resolve_country_code -- the same
# MaxMind GeoLite2 lookup already used for the Algeria-only write
# restriction. Bound alongside the IP rather than re-resolved on every
# individual model save() within the request: a single write (e.g.
# creating a Need) can cascade into several saves in one request (Need
# itself, then Campaign/recompute_status...), and the country can't change
# mid-request anyway. None whenever it can't be resolved -- no bound
# request, a private/local IP, or the GeoLite2 database isn't installed
# (see core/geoip.py; matches this project's existing best-effort
# convention rather than blocking the write).
current_request_country = contextvars.ContextVar("current_request_country", default=None)


class AuditMixin(models.Model):
    """Generic creator/editor audit trail retrofitted onto every table.

    Deliberately not a history table: an edit simply overwrites
    audit_updated_at/audit_editor_ip/audit_editor_country in place, there
    is no separate log of past edits (see AuditLog for the unrelated,
    pre-existing admin-action log, which this does not replace).

    All six columns are nullable specifically so this can be added to
    tables that already have rows: the migration adds them with no
    backfill, so every pre-existing row stays NULL forever unless/until
    it is itself next saved -- only rows created or edited from this
    point on ever get a non-NULL value here. The country columns are
    additionally best-effort even for brand-new rows: a write from
    outside Algeria is expected and allowed for international collection
    points (see CollectionPoint.country_code) even while the general
    geo-restriction is on, and the GeoLite2 database is itself optional
    infrastructure (README "GeoIP setup") -- either case just leaves the
    column NULL rather than blocking the write or guessing.

    Named audit_* rather than e.g. created_at/updated_at because several
    models already declare their own domain timestamp field under one of
    those names (Need.created_at, Pickup.pickup_date, ProgressUpdate.
    timestamp...) -- an abstract-model field with the same name as one the
    concrete model already declares is silently shadowed by Django (the
    concrete model's own field wins and no column is ever added for it),
    which would have quietly done nothing on exactly those models.

    Timestamps use timezone.now(): with settings.USE_TZ = True (see
    config/settings.py), Django always stores these in UTC in the
    database regardless of the display TIME_ZONE setting, so no explicit
    UTC conversion is needed here.
    """

    audit_created_at = models.DateTimeField(null=True, blank=True, editable=False)
    audit_updated_at = models.DateTimeField(null=True, blank=True, editable=False)
    audit_creator_ip = models.GenericIPAddressField(null=True, blank=True, editable=False)
    audit_editor_ip = models.GenericIPAddressField(null=True, blank=True, editable=False)
    # ISO 3166-1 alpha-2 (e.g. "DZ", "FR") -- same code shape as
    # CollectionPoint.country_code, resolved from the IP above rather than
    # user-submitted.
    audit_creator_country = models.CharField(max_length=2, null=True, blank=True, editable=False)
    audit_editor_country = models.CharField(max_length=2, null=True, blank=True, editable=False)

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        is_new = self._state.adding
        now = timezone.now()
        ip = current_request_ip.get()
        country = current_request_country.get()
        touched_fields = ["audit_updated_at", "audit_editor_ip", "audit_editor_country"]
        self.audit_updated_at = now
        self.audit_editor_ip = ip
        self.audit_editor_country = country
        if is_new:
            self.audit_created_at = now
            self.audit_creator_ip = ip
            self.audit_creator_country = country
            touched_fields += ["audit_created_at", "audit_creator_ip", "audit_creator_country"]
        # A caller that restricts the write to specific columns via
        # update_fields must still get these ones persisted -- otherwise
        # they'd be silently skipped by that same restriction (Django only
        # writes the columns named in update_fields).
        update_fields = kwargs.get("update_fields")
        if update_fields is not None:
            kwargs["update_fields"] = list(update_fields) + touched_fields
        super().save(*args, **kwargs)
