from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from core.models import AppConfiguration, Campaign, DisasterType, Need, Pickup, Wilaya


class BaseAPITestCase(TestCase):
    """Clears the throttle cache between tests (DRF's rate limiter uses the
    process-wide Django cache, which TestCase's DB transaction rollback does
    not reset) and, by default, disables the Algeria IP write restriction --
    mirroring the documented local-dev workaround (README "GeoIP setup"
    option b) so tests that aren't specifically about that restriction don't
    need to fake an Algerian IP. GeoRestrictionTests below overrides this."""

    disable_geo_restriction = True

    def setUp(self):
        cache.clear()
        self.client = APIClient()
        if self.disable_geo_restriction:
            config = AppConfiguration.get_solo()
            config.geo_restrict_writes_to_algeria = False
            config.save()


def make_campaign(status=Campaign.STATUS_ACTIVE, wilayas=None):
    dt = DisasterType.objects.create(name="Wildfire", icon="fire")
    campaign = Campaign.objects.create(campaign_name="Test campaign", disaster_type=dt, status=status)
    if wilayas is None:
        wilayas = list(Wilaya.objects.all()[:3])
    campaign.authorized_wilayas.set(wilayas)
    return campaign


NEED_PAYLOAD = {
    "title": "Blankets",
    "estimated_quantity": "about 50 families",
    "urgency": "critical",
    "commune": "Village X",
    "location_description": "Near the old school",
    "contact_last_name": "Benali",
    "contact_first_name": "Karim",
    "contact_phone": "0555000001",
    "contact_date_of_birth": "1990-01-01",
    "organization_or_person_name": "",
}


class SeedDataTests(TestCase):
    def test_58_wilayas_seeded(self):
        self.assertEqual(Wilaya.objects.count(), 58)

    def test_default_campaign_covers_all_wilayas(self):
        campaign = Campaign.objects.get(campaign_name="Général")
        self.assertEqual(campaign.status, Campaign.STATUS_ACTIVE)
        self.assertEqual(campaign.authorized_wilayas.count(), 58)


class NeedCreationTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()
        self.other_wilaya = Wilaya.objects.exclude(pk__in=self.campaign.authorized_wilayas.values("pk")).first()

    def _payload(self, **overrides):
        data = dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk)
        data.update(overrides)
        return data

    def test_create_need_returns_access_token(self):
        resp = self.client.post("/api/needs/", self._payload(), format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertIn("access_token", resp.data)
        self.assertEqual(len(resp.data["access_token"]), 32)
        self.assertIn("location_viewer_share_token", resp.data)

    def test_wilaya_must_be_in_campaign_authorized_list(self):
        resp = self.client.post("/api/needs/", self._payload(wilaya=self.other_wilaya.pk), format="json")
        self.assertEqual(resp.status_code, 400)

    def test_wilaya_check_is_server_side_not_just_frontend(self):
        """Directly hitting the API with a disallowed wilaya must fail even
        without going through any frontend dropdown."""
        bad = self._payload(wilaya=self.other_wilaya.pk)
        resp = self.client.post("/api/needs/", bad, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Need.objects.count(), 0)

    def test_cannot_create_when_campaign_paused(self):
        self.campaign.status = Campaign.STATUS_PAUSED
        self.campaign.save()
        resp = self.client.post("/api/needs/", self._payload(), format="json")
        self.assertEqual(resp.status_code, 400)

    def test_overall_status_not_settable_directly(self):
        payload = self._payload()
        payload["overall_status"] = "covered"
        resp = self.client.post("/api/needs/", payload, format="json")
        self.assertEqual(resp.status_code, 201)
        need = Need.objects.get(pk=resp.data["id"])
        self.assertEqual(need.overall_status, Need.STATUS_OPEN)

    def test_gps_outside_algeria_rejected(self):
        resp = self.client.post("/api/needs/", self._payload(latitude=48.85, longitude=2.35), format="json")
        self.assertEqual(resp.status_code, 400)

    def test_gps_inside_algeria_accepted_and_marks_exact(self):
        resp = self.client.post("/api/needs/", self._payload(latitude=36.75, longitude=3.06), format="json")
        self.assertEqual(resp.status_code, 201)
        need = Need.objects.get(pk=resp.data["id"])
        self.assertEqual(need.position_accuracy, Need.POSITION_EXACT)


class PickupAndStatusTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        self.need_id = resp.data["id"]
        self.need_token = resp.data["access_token"]

    def _pickup_payload(self, **overrides):
        data = {
            "need": self.need_id,
            "responder_type": "individual_volunteer",
            "responder_last_name": "Amrani",
            "responder_first_name": "Sara",
            "responder_phone": "0666000002",
            "responder_date_of_birth": "1995-05-05",
            "content_brought": "30 blankets",
        }
        data.update(overrides)
        return data

    def test_multiple_pickups_in_parallel_allowed(self):
        r1 = self.client.post("/api/pickups/", self._pickup_payload(), format="json")
        r2 = self.client.post(
            "/api/pickups/",
            self._pickup_payload(responder_last_name="Kaci", responder_phone="0777000003"),
            format="json",
        )
        self.assertEqual(r1.status_code, 201)
        self.assertEqual(r2.status_code, 201)
        need = Need.objects.get(pk=self.need_id)
        self.assertEqual(need.pickups.count(), 2)
        self.assertEqual(need.overall_status, Need.STATUS_PARTIALLY_COVERED)

    def test_status_becomes_covered_once_all_active_pickups_delivered(self):
        r1 = self.client.post("/api/pickups/", self._pickup_payload(), format="json")
        pickup_id, token = r1.data["id"], r1.data["access_token"]
        resp = self.client.post(f"/api/pickups/{pickup_id}/deliver/", {"access_token": token}, format="json")
        self.assertEqual(resp.status_code, 200)
        need = Need.objects.get(pk=self.need_id)
        self.assertEqual(need.overall_status, Need.STATUS_COVERED)

    def test_progress_update_requires_no_gps_and_works_with_only_token(self):
        r1 = self.client.post("/api/pickups/", self._pickup_payload(), format="json")
        pickup_id, token = r1.data["id"], r1.data["access_token"]
        resp = self.client.post(
            f"/api/pickups/{pickup_id}/progress-updates/",
            {"free_text": "Just passed Boumerdès", "access_token": token},
            format="json",
        )
        self.assertEqual(resp.status_code, 201)
        self.assertIsNone(resp.data["gps_latitude"])

    def test_progress_update_wrong_token_rejected(self):
        r1 = self.client.post("/api/pickups/", self._pickup_payload(), format="json")
        pickup_id = r1.data["id"]
        resp = self.client.post(
            f"/api/pickups/{pickup_id}/progress-updates/",
            {"free_text": "hijack attempt", "access_token": "wrong-token"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_edit_requires_matching_token(self):
        resp = self.client.patch(
            f"/api/needs/{self.need_id}/",
            {"title": "New title", "access_token": "wrong"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)
        resp = self.client.patch(
            f"/api/needs/{self.need_id}/",
            {"title": "New title", "access_token": self.need_token},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["title"], "New title")

    def test_identity_recovery_issues_new_token_and_invalidates_old(self):
        resp = self.client.post(
            f"/api/needs/{self.need_id}/recover-access/",
            {
                "last_name": NEED_PAYLOAD["contact_last_name"],
                "first_name": NEED_PAYLOAD["contact_first_name"],
                "phone": NEED_PAYLOAD["contact_phone"],
                "date_of_birth": NEED_PAYLOAD["contact_date_of_birth"],
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        new_token = resp.data["access_token"]
        self.assertNotEqual(new_token, self.need_token)

        # old token no longer works
        resp = self.client.patch(
            f"/api/needs/{self.need_id}/",
            {"title": "x", "access_token": self.need_token},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

        # new token works
        resp = self.client.patch(
            f"/api/needs/{self.need_id}/",
            {"title": "x", "access_token": new_token},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)

    def test_identity_recovery_wrong_identity_rejected(self):
        resp = self.client.post(
            f"/api/needs/{self.need_id}/recover-access/",
            {"last_name": "Wrong", "first_name": "Wrong", "phone": "0000000000", "date_of_birth": "2000-01-01"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_to_verify_after_24h_without_update(self):
        r1 = self.client.post("/api/pickups/", self._pickup_payload(), format="json")
        pickup = Pickup.objects.get(pk=r1.data["id"])
        pickup.created_at = pickup.created_at.replace(year=2000)
        pickup.save()
        self.assertTrue(pickup.needs_verification)


class AdminOverrideTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        self.need_id = resp.data["id"]
        self.admin = get_user_model().objects.create_superuser("admin", "admin@example.com", "pw123456!")

    def test_admin_can_edit_without_token(self):
        self.client.force_authenticate(self.admin)
        resp = self.client.patch(f"/api/needs/{self.need_id}/", {"title": "Overridden"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["title"], "Overridden")

    def test_admin_override_is_logged(self):
        from core.models import AuditLog

        self.client.force_authenticate(self.admin)
        self.client.patch(f"/api/needs/{self.need_id}/", {"title": "Overridden"}, format="json")
        self.assertTrue(AuditLog.objects.filter(action="edited need").exists())

    def test_non_admin_cannot_edit_without_token(self):
        resp = self.client.patch(f"/api/needs/{self.need_id}/", {"title": "Hacked"}, format="json")
        self.assertEqual(resp.status_code, 403)


class ReadOnlyModeTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    def test_read_only_blocks_creation(self):
        config = AppConfiguration.get_solo()
        config.mode = AppConfiguration.MODE_READ_ONLY
        config.save()
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_read_only_does_not_block_reading(self):
        self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        config = AppConfiguration.get_solo()
        config.mode = AppConfiguration.MODE_READ_ONLY
        config.save()
        resp = self.client.get("/api/needs/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["results"]), 1)


class AnonymizationTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        self.need_id = resp.data["id"]
        self.token = resp.data["access_token"]

    def test_self_service_anonymize_requires_confirmation_when_active(self):
        resp = self.client.post(
            f"/api/needs/{self.need_id}/anonymize/", {"access_token": self.token}, format="json"
        )
        self.assertEqual(resp.status_code, 400)
        self.assertTrue(resp.data["requires_confirmation"])

        resp = self.client.post(
            f"/api/needs/{self.need_id}/anonymize/",
            {"access_token": self.token, "confirm": True},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        need = Need.objects.get(pk=self.need_id)
        self.assertTrue(need.is_anonymized)
        self.assertEqual(need.contact_last_name, "Anonymized")
        self.assertEqual(need.title, NEED_PAYLOAD["title"])  # untouched

    def test_anonymize_no_warning_when_cancelled(self):
        self.client.patch(
            f"/api/needs/{self.need_id}/",
            {"is_cancelled": True, "access_token": self.token},
            format="json",
        )
        resp = self.client.post(
            f"/api/needs/{self.need_id}/anonymize/", {"access_token": self.token}, format="json"
        )
        self.assertEqual(resp.status_code, 200)

    def test_anonymized_fields_hidden_everywhere_including_admin(self):
        self.client.post(
            f"/api/needs/{self.need_id}/anonymize/",
            {"access_token": self.token, "confirm": True},
            format="json",
        )
        resp = self.client.get(f"/api/needs/{self.need_id}/")
        self.assertEqual(resp.data["contact_last_name"], "Anonymized")
        self.assertEqual(resp.data["contact_phone"], "")

        admin_user = get_user_model().objects.create_superuser("admin2", "a2@example.com", "pw123456!")
        from django.test import Client as DjangoClient

        django_client = DjangoClient()
        django_client.force_login(admin_user)
        response = django_client.get(f"/admin/core/need/{self.need_id}/change/")
        self.assertNotIn(b"Benali", response.content)

    def test_token_stops_working_after_anonymization(self):
        self.client.post(
            f"/api/needs/{self.need_id}/anonymize/",
            {"access_token": self.token, "confirm": True},
            format="json",
        )
        resp = self.client.patch(
            f"/api/needs/{self.need_id}/",
            {"title": "still mine?", "access_token": self.token},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_admin_bulk_anonymize_at_campaign_closure_is_deliberate_not_automatic(self):
        self.campaign.status = Campaign.STATUS_STOPPED
        self.campaign.save()
        need = Need.objects.get(pk=self.need_id)
        self.assertFalse(need.is_anonymized)  # stopping the campaign alone must NOT anonymize


class MapAndLocationPrivacyTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        self.need_id = resp.data["id"]
        self.need_token = resp.data["access_token"]
        self.share_token = resp.data["location_viewer_share_token"]

        pickup_resp = self.client.post(
            "/api/pickups/",
            {
                "need": self.need_id,
                "responder_type": "individual_volunteer",
                "responder_last_name": "Amrani",
                "responder_first_name": "Sara",
                "responder_phone": "0666000002",
                "responder_date_of_birth": "1995-05-05",
                "content_brought": "30 blankets",
            },
            format="json",
        )
        self.pickup_id = pickup_resp.data["id"]
        self.pickup_token = pickup_resp.data["access_token"]
        self.client.post(
            f"/api/pickups/{self.pickup_id}/location-pings/",
            {"latitude": 36.75, "longitude": 3.04, "access_token": self.pickup_token},
            format="json",
        )

    def test_main_map_never_exposes_pickup_positions(self):
        resp = self.client.get("/api/needs/locations/")
        self.assertEqual(resp.status_code, 200)
        for item in resp.data:
            self.assertNotIn("pickups", item)
            self.assertNotIn("latitude_pickup", item)

    def test_anonymous_visitor_cannot_see_pickup_locations(self):
        resp = self.client.get(f"/api/needs/{self.need_id}/pickup-locations/")
        self.assertEqual(resp.status_code, 403)

    def test_creator_can_see_pickup_locations(self):
        resp = self.client.get(
            f"/api/needs/{self.need_id}/pickup-locations/", {"access_token": self.need_token}
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertEqual(len(resp.data[0]["trail"]), 1)

    def test_share_link_holder_can_see_pickup_locations(self):
        resp = self.client.get(
            f"/api/needs/{self.need_id}/pickup-locations/", {"viewer": self.share_token}
        )
        self.assertEqual(resp.status_code, 200)

    def test_regenerating_share_token_invalidates_old_link(self):
        resp = self.client.post(
            f"/api/needs/{self.need_id}/regenerate-share-token/",
            {"access_token": self.need_token},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        new_token = resp.data["location_viewer_share_token"]
        self.assertNotEqual(new_token, self.share_token)

        resp = self.client.get(
            f"/api/needs/{self.need_id}/pickup-locations/", {"viewer": self.share_token}
        )
        self.assertEqual(resp.status_code, 403)

        resp = self.client.get(
            f"/api/needs/{self.need_id}/pickup-locations/", {"viewer": new_token}
        )
        self.assertEqual(resp.status_code, 200)

    def test_progress_update_timeline_always_public(self):
        self.client.post(
            f"/api/pickups/{self.pickup_id}/progress-updates/",
            {"free_text": "arriving soon", "access_token": self.pickup_token},
            format="json",
        )
        resp = self.client.get(f"/api/needs/{self.need_id}/")
        texts = [u["free_text"] for p in resp.data["pickups"] for u in p["progress_updates"]]
        self.assertIn("arriving soon", texts)


@override_settings(GEOIP_DB_PATH="/nonexistent/GeoLite2-Country.mmdb")
class GeoRestrictionTests(BaseAPITestCase):
    disable_geo_restriction = False

    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    def _payload(self):
        return dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk)

    def test_write_blocked_when_ip_not_algeria_and_restriction_enabled(self):
        config = AppConfiguration.get_solo()
        config.geo_restrict_writes_to_algeria = True
        config.save()
        resp = self.client.post(
            "/api/needs/", self._payload(), format="json", REMOTE_ADDR="8.8.8.8"
        )
        self.assertEqual(resp.status_code, 403)

    def test_write_allowed_when_restriction_disabled(self):
        config = AppConfiguration.get_solo()
        config.geo_restrict_writes_to_algeria = False
        config.save()
        resp = self.client.post(
            "/api/needs/", self._payload(), format="json", REMOTE_ADDR="8.8.8.8"
        )
        self.assertEqual(resp.status_code, 201)

    def test_admin_bypasses_restriction_even_from_non_algeria_ip(self):
        config = AppConfiguration.get_solo()
        config.geo_restrict_writes_to_algeria = True
        config.save()
        admin = get_user_model().objects.create_superuser("admin3", "a3@example.com", "pw123456!")
        self.client.force_authenticate(admin)
        resp = self.client.post(
            "/api/needs/", self._payload(), format="json", REMOTE_ADDR="8.8.8.8"
        )
        self.assertEqual(resp.status_code, 201)

    def test_reading_always_works_regardless_of_restriction_or_location(self):
        config = AppConfiguration.get_solo()
        config.geo_restrict_writes_to_algeria = True
        config.save()
        resp = self.client.get("/api/needs/", REMOTE_ADDR="8.8.8.8")
        self.assertEqual(resp.status_code, 200)


class RateLimitTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    def test_rate_limit_returns_clear_error_not_silent_drop(self):
        # Exercises the real default rate (settings.RATE_LIMIT_CREATIONS_PER_HOUR,
        # 20/hour) rather than overriding it: DRF's SimpleRateThrottle snapshots
        # DEFAULT_THROTTLE_RATES onto a class attribute at import time, so
        # override_settings(REST_FRAMEWORK=...) doesn't reliably reach it.
        from django.conf import settings

        payload = dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk)
        limit = settings.RATE_LIMIT_CREATIONS_PER_HOUR
        for _ in range(limit):
            resp = self.client.post("/api/needs/", payload, format="json")
            self.assertEqual(resp.status_code, 201)
        resp = self.client.post("/api/needs/", payload, format="json")
        self.assertEqual(resp.status_code, 429)
        self.assertIn("detail", resp.data)
