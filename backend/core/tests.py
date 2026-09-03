from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from core.models import AdminContactPhone, AppConfiguration, Campaign, CollectionPoint, DisasterType, Need, Pickup, ProgressUpdate, TranslationOverride, Wilaya


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


def _admin_site():
    from django.contrib.admin.sites import AdminSite

    return AdminSite()


def _fake_admin_request(user):
    """A RequestFactory request usable with ModelAdmin.message_user, which
    needs a messages storage attached (normally provided by MessageMiddleware)."""
    from django.contrib.messages.storage.fallback import FallbackStorage
    from django.test import RequestFactory

    request = RequestFactory().post("/admin/")
    request.user = user
    request.session = {}
    request._messages = FallbackStorage(request)
    return request


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
    "contact_name": "Karim Benali",
    "contact_phone": "0555000001",
    "organization_or_person_name": "",
}


class SeedDataTests(TestCase):
    def test_58_wilayas_seeded(self):
        self.assertEqual(Wilaya.objects.count(), 58)

    def test_general_campaign_covers_all_wilayas(self):
        # "Général" is the baseline seed campaign covering every wilaya --
        # kept around (not deleted) but paused once the real "Feux en
        # Algérie" campaign exists (0007_wildfire_campaign), since the
        # create-need form locks its campaign picker to whichever campaign
        # is active and only one should be at a time.
        campaign = Campaign.objects.get(campaign_name="Général")
        self.assertEqual(campaign.authorized_wilayas.count(), 58)

    def test_wildfire_campaign_is_the_active_one_restricted_to_affected_wilayas(self):
        campaign = Campaign.objects.get(campaign_name="Feux en Algérie")
        self.assertEqual(campaign.status, Campaign.STATUS_ACTIVE)
        names = set(campaign.authorized_wilayas.values_list("name", flat=True))
        self.assertEqual(len(names), 18)
        self.assertIn("Béjaïa", names)
        self.assertIn("Tizi Ouzou", names)
        self.assertNotIn("Adrar", names)  # not a fire-affected wilaya

        general = Campaign.objects.get(campaign_name="Général")
        self.assertEqual(general.status, Campaign.STATUS_PAUSED)


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

    def test_other_phones_is_optional_freetext(self):
        resp = self.client.post("/api/needs/", self._payload(), format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["other_phones"], "")

    def test_other_phones_saved_and_returned(self):
        resp = self.client.post("/api/needs/", self._payload(other_phones="0555000002\n0555000003"), format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["other_phones"], "0555000002\n0555000003")

    def test_other_phones_editable_after_creation(self):
        create_resp = self.client.post("/api/needs/", self._payload(), format="json")
        need_id, token = create_resp.data["id"], create_resp.data["access_token"]
        patch_resp = self.client.patch(
            f"/api/needs/{need_id}/", {"other_phones": "0555999999", "access_token": token}, format="json"
        )
        self.assertEqual(patch_resp.status_code, 200, patch_resp.content)
        self.assertEqual(patch_resp.data["other_phones"], "0555999999")


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
            "responder_name": "Sara Amrani",
            "responder_phone": "0666000002",
            "content_brought": "30 blankets",
        }
        data.update(overrides)
        return data

    def test_multiple_pickups_in_parallel_allowed(self):
        r1 = self.client.post("/api/pickups/", self._pickup_payload(), format="json")
        r2 = self.client.post(
            "/api/pickups/",
            self._pickup_payload(responder_name="Kaci", responder_phone="0777000003"),
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
                "name": NEED_PAYLOAD["contact_name"],
                "phone": NEED_PAYLOAD["contact_phone"],
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
            {"name": "Wrong", "phone": "0000000000"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_code_recovery_issues_new_token(self):
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, recovery_code="myPin123"),
            format="json",
        )
        need_id = resp.data["id"]
        resp = self.client.post(f"/api/needs/{need_id}/recover-access/", {"code": "myPin123"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("access_token", resp.data)

    def test_code_recovery_wrong_code_rejected(self):
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, recovery_code="myPin123"),
            format="json",
        )
        need_id = resp.data["id"]
        resp = self.client.post(f"/api/needs/{need_id}/recover-access/", {"code": "wrongPin"}, format="json")
        self.assertEqual(resp.status_code, 403)

    def test_recovery_code_too_short_rejected(self):
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, recovery_code="abc12"),
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("recovery_code", resp.data)

    def test_recovery_code_must_be_unique(self):
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, recovery_code="sharedCode1"),
            format="json",
        )
        self.assertEqual(resp.status_code, 201)
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, recovery_code="sharedCode1"),
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("recovery_code", resp.data)

    def test_blank_recovery_code_never_collides(self):
        resp1 = self.client.post("/api/needs/", dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk), format="json")
        resp2 = self.client.post("/api/needs/", dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk), format="json")
        self.assertEqual(resp1.status_code, 201)
        self.assertEqual(resp2.status_code, 201)

    def test_pickup_recovery_code_too_short_rejected(self):
        resp = self.client.post("/api/pickups/", self._pickup_payload(recovery_code="abc12"), format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("recovery_code", resp.data)

    def test_pickup_recovery_code_must_be_unique(self):
        resp1 = self.client.post("/api/pickups/", self._pickup_payload(recovery_code="pickupCode1"), format="json")
        self.assertEqual(resp1.status_code, 201)
        resp2 = self.client.post("/api/pickups/", self._pickup_payload(recovery_code="pickupCode1"), format="json")
        self.assertEqual(resp2.status_code, 400)
        self.assertIn("recovery_code", resp2.data)

    def test_need_and_pickup_recovery_codes_do_not_collide_across_models(self):
        # Uniqueness is enforced within the same model (Need vs Pickup), not
        # globally, since recovery is always looked up against one specific
        # listing's id, never a bare code alone -- see check_recovery_code_available.
        need_resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, recovery_code="crossModel1"),
            format="json",
        )
        self.assertEqual(need_resp.status_code, 201)
        pickup_resp = self.client.post("/api/pickups/", self._pickup_payload(recovery_code="crossModel1"), format="json")
        self.assertEqual(pickup_resp.status_code, 201)

    def test_to_verify_after_24h_without_update(self):
        r1 = self.client.post("/api/pickups/", self._pickup_payload(), format="json")
        pickup = Pickup.objects.get(pk=r1.data["id"])
        pickup.created_at = pickup.created_at.replace(year=2000)
        pickup.save()
        self.assertTrue(pickup.needs_verification)


class PickupListTests(BaseAPITestCase):
    """The global "deliveries in progress" list (GET /api/pickups/), added
    alongside the frontend screen of the same name -- covers the
    wilaya/status filters and that the list payload carries enough need
    context (need_title/need_wilaya_name) to render without a second
    request per row."""

    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilayas = list(self.campaign.authorized_wilayas.all())
        self.need1 = self.client.post(
            "/api/needs/", dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilayas[0].pk), format="json"
        ).data
        self.need2 = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, title="Other need", campaign=self.campaign.pk, wilaya=self.wilayas[1].pk),
            format="json",
        ).data

    def _pickup(self, need_id, **overrides):
        data = {
            "need": need_id,
            "responder_type": "individual_volunteer",
            "responder_name": "Sara Amrani",
            "responder_phone": "0666000002",
            "content_brought": "30 blankets",
        }
        data.update(overrides)
        return self.client.post("/api/pickups/", data, format="json").data

    def test_list_includes_need_context(self):
        self._pickup(self.need1["id"])
        resp = self.client.get("/api/pickups/")
        self.assertEqual(resp.status_code, 200)
        row = resp.data["results"][0]
        self.assertEqual(row["need_title"], self.need1["title"])
        self.assertEqual(row["need_wilaya_name"], self.wilayas[0].name)
        self.assertEqual(row["status"], "en_route")

    def test_filter_by_status(self):
        p1 = self._pickup(self.need1["id"])
        self._pickup(self.need2["id"], responder_phone="0777000003")
        self.client.post(f"/api/pickups/{p1['id']}/deliver/", {"access_token": p1["access_token"]}, format="json")

        resp = self.client.get("/api/pickups/?status=delivered")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["results"]), 1)
        self.assertEqual(resp.data["results"][0]["id"], p1["id"])

        resp = self.client.get("/api/pickups/?status=en_route")
        self.assertEqual(len(resp.data["results"]), 1)
        self.assertNotEqual(resp.data["results"][0]["id"], p1["id"])

    def test_filter_by_wilaya(self):
        self._pickup(self.need1["id"])
        self._pickup(self.need2["id"], responder_phone="0777000003")

        resp = self.client.get(f"/api/pickups/?wilaya={self.wilayas[0].pk}")
        self.assertEqual(len(resp.data["results"]), 1)
        self.assertEqual(resp.data["results"][0]["need_wilaya_name"], self.wilayas[0].name)

        resp = self.client.get(f"/api/pickups/?wilaya={self.wilayas[1].pk}")
        self.assertEqual(len(resp.data["results"]), 1)
        self.assertEqual(resp.data["results"][0]["need_wilaya_name"], self.wilayas[1].name)


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

    def test_read_only_blocks_pickup_creation(self):
        need_resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        config = AppConfiguration.get_solo()
        config.mode = AppConfiguration.MODE_READ_ONLY
        config.save()
        resp = self.client.post(
            "/api/pickups/",
            {
                "need": need_resp.data["id"],
                "responder_type": "individual_volunteer",
                "responder_name": "A B",
                "responder_phone": "0600",
                "content_brought": "x",
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_read_only_blocks_progress_update_creation(self):
        config = AppConfiguration.get_solo()
        config.mode = AppConfiguration.MODE_NORMAL
        config.save()
        need_resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        pickup_resp = self.client.post(
            "/api/pickups/",
            {
                "need": need_resp.data["id"],
                "responder_type": "individual_volunteer",
                "responder_name": "A B",
                "responder_phone": "0600",
                "content_brought": "x",
            },
            format="json",
        )
        config.mode = AppConfiguration.MODE_READ_ONLY
        config.save()
        resp = self.client.post(
            f"/api/pickups/{pickup_resp.data['id']}/progress-updates/",
            {"free_text": "hello", "access_token": pickup_resp.data["access_token"]},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)


class UpdateGPSTests(BaseAPITestCase):
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

    def test_creator_can_add_gps_after_creation_pin_moves_to_exact(self):
        need = Need.objects.get(pk=self.need_id)
        self.assertEqual(need.position_accuracy, Need.POSITION_APPROXIMATE)
        self.assertIsNone(need.latitude)

        resp = self.client.post(
            f"/api/needs/{self.need_id}/update-gps/",
            {"latitude": 36.75, "longitude": 3.06, "access_token": self.token},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        need.refresh_from_db()
        self.assertEqual(need.position_accuracy, Need.POSITION_EXACT)
        self.assertAlmostEqual(need.latitude, 36.75)
        self.assertAlmostEqual(need.longitude, 3.06)

    def test_update_gps_outside_algeria_rejected(self):
        resp = self.client.post(
            f"/api/needs/{self.need_id}/update-gps/",
            {"latitude": 48.85, "longitude": 2.35, "access_token": self.token},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_update_gps_wrong_token_rejected(self):
        resp = self.client.post(
            f"/api/needs/{self.need_id}/update-gps/",
            {"latitude": 36.75, "longitude": 3.06, "access_token": "wrong"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_update_gps_does_not_affect_existing_pickups(self):
        pickup_resp = self.client.post(
            "/api/pickups/",
            {
                "need": self.need_id,
                "responder_type": "individual_volunteer",
                "responder_name": "A B",
                "responder_phone": "0600",
                "content_brought": "x",
            },
            format="json",
        )
        self.client.post(
            f"/api/needs/{self.need_id}/update-gps/",
            {"latitude": 36.75, "longitude": 3.06, "access_token": self.token},
            format="json",
        )
        pickup = Pickup.objects.get(pk=pickup_resp.data["id"])
        self.assertEqual(pickup.status, Pickup.STATUS_EN_ROUTE)


class TurnstileCaptchaTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    @override_settings(TURNSTILE_ENABLED=True, TURNSTILE_SECRET_KEY="fake-secret-for-test")
    def test_creation_rejected_without_captcha_token_when_enabled(self):
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_creation_allowed_without_captcha_token_when_disabled(self):
        # settings.TURNSTILE_ENABLED is False by default (no secret key
        # configured in this environment) -- verified skipped entirely.
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk),
            format="json",
        )
        self.assertEqual(resp.status_code, 201)


class AnonymizationTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, other_phones="0555000002"),
            format="json",
        )
        self.need_id = resp.data["id"]
        self.token = resp.data["access_token"]

    def test_anonymize_clears_other_phones_too(self):
        self.client.post(f"/api/needs/{self.need_id}/anonymize/", {"access_token": self.token}, format="json")
        resp = self.client.post(
            f"/api/needs/{self.need_id}/anonymize/",
            {"access_token": self.token, "confirm": True},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        need = Need.objects.get(pk=self.need_id)
        self.assertEqual(need.other_phones, "")

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
        self.assertEqual(need.contact_name, "Anonymized")
        self.assertEqual(need.title, NEED_PAYLOAD["title"])  # untouched

    def test_anonymize_is_idempotent_a_repeat_call_never_undoes_it(self):
        # Regression: a double-click on "Anonymiser mes informations" used
        # to be able to fire two overlapping requests from the frontend.
        # The backend side of that must be a harmless no-op either way --
        # anonymizing twice must never restore or otherwise change data.
        self.client.post(
            f"/api/needs/{self.need_id}/anonymize/", {"access_token": self.token, "confirm": True}, format="json"
        )
        need = Need.objects.get(pk=self.need_id)
        self.assertTrue(need.is_anonymized)
        first_obfuscated_at = need.pii_obfuscated_at

        resp = self.client.post(
            f"/api/needs/{self.need_id}/anonymize/", {"access_token": self.token}, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["detail"], "Already anonymized.")
        need.refresh_from_db()
        self.assertTrue(need.is_anonymized)
        self.assertEqual(need.contact_name, "Anonymized")
        self.assertEqual(need.pii_obfuscated_at, first_obfuscated_at)  # untouched by the repeat call

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
        self.assertEqual(resp.data["contact_name"], "Anonymized")
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
                "responder_name": "Sara Amrani",
                "responder_phone": "0666000002",
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

    def test_progress_update_gps_never_exposed_via_public_need_detail(self):
        """A progress update's optional GPS must never leak through the
        fully public Need-detail endpoint -- that would bypass the
        access-controlled pickup-locations endpoint's privacy boundary
        entirely. GPS is only ever echoed back to the pickup's own token
        holder right after they submit it (asserted below)."""
        create_resp = self.client.post(
            f"/api/pickups/{self.pickup_id}/progress-updates/",
            {"free_text": "at the drop-off point", "gps_latitude": 36.75, "gps_longitude": 3.04, "access_token": self.pickup_token},
            format="json",
        )
        self.assertEqual(create_resp.status_code, 201, create_resp.content)
        # The creator (token holder) IS shown their own just-submitted GPS.
        self.assertEqual(create_resp.data["gps_latitude"], 36.75)

        resp = self.client.get(f"/api/needs/{self.need_id}/")
        for p in resp.data["pickups"]:
            for u in p["progress_updates"]:
                self.assertNotIn("gps_latitude", u)
                self.assertNotIn("gps_longitude", u)

        update = ProgressUpdate.objects.get(pickup_id=self.pickup_id, free_text="at the drop-off point")
        self.assertEqual(update.gps_latitude, 36.75)  # it WAS stored, just never publicly serialized


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


class ClientIPSpoofingTests(BaseAPITestCase):
    """core.middleware.get_client_ip must not let a client dictate its own
    IP for geo-restriction/rate-limiting purposes -- see DEPLOYMENT.md's
    Nginx config (X-Real-IP always set fresh by Nginx; X-Forwarded-For only
    ever appended to, so only the LAST entry is Nginx's own, trustworthy
    value)."""

    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    def test_x_real_ip_is_trusted_over_x_forwarded_for(self):
        from django.test import RequestFactory

        from core.middleware import get_client_ip

        request = RequestFactory().get("/", HTTP_X_REAL_IP="41.100.0.5", HTTP_X_FORWARDED_FOR="1.2.3.4")
        self.assertEqual(get_client_ip(request), "41.100.0.5")

    def test_x_forwarded_for_uses_last_entry_not_first(self):
        from django.test import RequestFactory

        from core.middleware import get_client_ip

        # Simulates Nginx's $proxy_add_x_forwarded_for: whatever a client
        # sent is kept as-is, with Nginx's own view of the real peer
        # appended last -- only that last entry can be trusted.
        request = RequestFactory().get("/", HTTP_X_FORWARDED_FOR="9.9.9.9, 41.100.0.5")
        self.assertEqual(get_client_ip(request), "41.100.0.5")

    def test_spoofed_first_hop_no_longer_bypasses_rate_limit(self):
        from django.conf import settings

        payload = dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk)
        limit = settings.RATE_LIMIT_CREATIONS_PER_HOUR
        # A different fake first hop on every request (what a client fully
        # controls), but the same real Nginx-appended last hop -- all
        # requests must land in the same rate-limit bucket.
        for i in range(limit):
            resp = self.client.post(
                "/api/needs/", payload, format="json",
                HTTP_X_FORWARDED_FOR=f"{i}.{i}.{i}.{i}, 41.100.0.5",
            )
            self.assertEqual(resp.status_code, 201)
        resp = self.client.post(
            "/api/needs/", payload, format="json",
            HTTP_X_FORWARDED_FOR="255.255.255.255, 41.100.0.5",
        )
        self.assertEqual(resp.status_code, 429)


def make_test_image(name="photo.jpg"):
    import io

    from PIL import Image
    from django.core.files.uploadedfile import SimpleUploadedFile

    buf = io.BytesIO()
    Image.new("RGB", (10, 10), color="red").save(buf, format="JPEG")
    return SimpleUploadedFile(name, buf.getvalue(), content_type="image/jpeg")


class MediaUploadTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    def _multipart_payload(self, **overrides):
        data = dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk)
        data.update(overrides)
        return data

    def test_create_need_with_damage_photos(self):
        resp = self.client.post(
            "/api/needs/",
            self._multipart_payload(
                damage_photos=[make_test_image("a.jpg"), make_test_image("b.jpg")]
            ),
            format="multipart",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(len(resp.data["damage_photos"]), 2)
        need = Need.objects.get(pk=resp.data["id"])
        self.assertEqual(need.damage_photos.count(), 2)

    def test_damage_photos_capped_at_3(self):
        resp = self.client.post(
            "/api/needs/",
            self._multipart_payload(
                damage_photos=[
                    make_test_image("a.jpg"), make_test_image("b.jpg"),
                    make_test_image("c.jpg"), make_test_image("d.jpg"),
                ]
            ),
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Need.objects.count(), 0)

    def test_damage_photo_rejected_when_oversized(self):
        from django.core.files.uploadedfile import SimpleUploadedFile
        from core.media_validation import MAX_PHOTO_SIZE_BYTES

        oversized = SimpleUploadedFile("big.jpg", b"x" * (MAX_PHOTO_SIZE_BYTES + 1), content_type="image/jpeg")
        resp = self.client.post(
            "/api/needs/",
            self._multipart_payload(damage_photos=[oversized]),
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Need.objects.count(), 0)

    def test_at_least_one_of_description_voice_video_required(self):
        resp = self.client.post(
            "/api/needs/",
            self._multipart_payload(location_description=""),
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Need.objects.count(), 0)

    def test_description_only_accepted_voice_and_video_optional(self):
        resp = self.client.post("/api/needs/", self._multipart_payload(), format="multipart")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertIsNone(resp.data["voice_file"])
        self.assertIsNone(resp.data["video_file"])

    def test_voice_only_accepted_no_description_needed(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        audio = SimpleUploadedFile("voice.webm", b"fake-audio-bytes", content_type="audio/webm")
        resp = self.client.post(
            "/api/needs/",
            self._multipart_payload(location_description="", voice_file=audio),
            format="multipart",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        need = Need.objects.get(pk=resp.data["id"])
        self.assertTrue(need.voice_file.name)
        # voice is never moderated, so its URL is present immediately
        self.assertIsNotNone(resp.data["voice_file"])

    def test_voice_and_video_and_text_combinable(self):
        """The spec explicitly wants these combinable, not mutually
        exclusive -- someone reporting in an emergency can attach as many
        as they're able to."""
        from django.core.files.uploadedfile import SimpleUploadedFile
        from unittest.mock import patch

        audio = SimpleUploadedFile("voice.webm", b"fake-audio-bytes", content_type="audio/webm")
        video = SimpleUploadedFile("clip.webm", b"fake-video-bytes", content_type="video/webm")
        with patch("core.serializers.validate_video_duration"):
            resp = self.client.post(
                "/api/needs/",
                self._multipart_payload(voice_file=audio, video_file=video),
                format="multipart",
            )
        self.assertEqual(resp.status_code, 201, resp.content)
        need = Need.objects.get(pk=resp.data["id"])
        self.assertTrue(need.voice_file.name)
        self.assertTrue(need.video_file.name)
        self.assertTrue(need.location_description)

    def test_video_duration_rejected_when_determinable(self):
        from unittest.mock import patch
        from django.core.files.uploadedfile import SimpleUploadedFile

        video = SimpleUploadedFile("clip.webm", b"fake-video-bytes", content_type="video/webm")
        with patch("core.serializers.validate_video_duration") as mocked:
            from rest_framework import serializers as drf_serializers

            mocked.side_effect = drf_serializers.ValidationError("Video is 35s long, the maximum is 20s.")
            resp = self.client.post(
                "/api/needs/",
                self._multipart_payload(video_file=video),
                format="multipart",
            )
        self.assertEqual(resp.status_code, 400)

    def test_video_rejected_when_oversized(self):
        """The 10MB video size cap is unconditional, unlike the
        opt-in duration check -- confirmed by not touching
        enforce_video_duration_check here at all."""
        from django.core.files.uploadedfile import SimpleUploadedFile
        from core.media_validation import MAX_VIDEO_SIZE_BYTES

        oversized = SimpleUploadedFile("big.webm", b"x" * (MAX_VIDEO_SIZE_BYTES + 1), content_type="video/webm")
        resp = self.client.post(
            "/api/needs/",
            self._multipart_payload(video_file=oversized),
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Need.objects.count(), 0)

    def test_video_accepted_by_default_even_when_duration_undeterminable(self):
        """Server-side duration verification is opt-in, off by default (see
        AppConfiguration.enforce_video_duration_check) -- with it off, a
        video is accepted even when its duration can't be verified (no
        ffprobe on PATH -- true in this sandbox, so this exercises the
        real code path, no mocking needed), so a server without ffmpeg
        installed doesn't reject every video submission outright."""
        from django.core.files.uploadedfile import SimpleUploadedFile
        from core.media_validation import ffprobe_available

        self.assertFalse(ffprobe_available(), "this test assumes ffprobe is not installed")
        video = SimpleUploadedFile("clip.webm", b"fake-video-bytes", content_type="video/webm")
        resp = self.client.post(
            "/api/needs/",
            self._multipart_payload(video_file=video),
            format="multipart",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(Need.objects.count(), 1)

    def test_video_rejected_when_duration_undeterminable_and_check_enforced(self):
        """Once an admin turns enforce_video_duration_check on, the
        fail-closed behavior applies: an unverifiable duration is rejected
        rather than silently accepted, since accepting it would mean the
        20s cap is unenforced despite the setting saying it should be."""
        from django.core.files.uploadedfile import SimpleUploadedFile
        from core.media_validation import ffprobe_available
        from core.models import AppConfiguration

        self.assertFalse(ffprobe_available(), "this test assumes ffprobe is not installed")
        config = AppConfiguration.get_solo()
        config.enforce_video_duration_check = True
        config.save()
        video = SimpleUploadedFile("clip.webm", b"fake-video-bytes", content_type="video/webm")
        resp = self.client.post(
            "/api/needs/",
            self._multipart_payload(video_file=video),
            format="multipart",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(Need.objects.count(), 0)

    def test_delivery_photos_on_deliver(self):
        need_resp = self.client.post("/api/needs/", self._multipart_payload(), format="json")
        pickup_resp = self.client.post(
            "/api/pickups/",
            {
                "need": need_resp.data["id"],
                "responder_type": "individual_volunteer",
                "responder_name": "A B",
                "responder_phone": "0600",
                "content_brought": "x",
            },
            format="json",
        )
        resp = self.client.post(
            f"/api/pickups/{pickup_resp.data['id']}/deliver/",
            {"access_token": pickup_resp.data["access_token"], "delivery_photos": [make_test_image("d.jpg")]},
            format="multipart",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(len(resp.data["delivery_photos"]), 1)

    def test_media_stored_via_configured_storage_backend(self):
        # Local dev has no R2 credentials configured, so this exercises the
        # documented fallback (FileSystemStorage) -- see settings.USE_R2_STORAGE.
        from django.conf import settings

        self.assertFalse(settings.USE_R2_STORAGE)
        resp = self.client.post(
            "/api/needs/", self._multipart_payload(damage_photos=[make_test_image()]), format="multipart"
        )
        need = Need.objects.get(pk=resp.data["id"])
        photo = need.damage_photos.first()
        self.assertTrue(photo.image.storage.exists(photo.image.name))


class ModerationTests(BaseAPITestCase):
    """Wave 3: automatic NSFWJS moderation. Behavior tests use mocks for
    deterministic, CI-reproducible results (approve/reject/pending is a
    business-logic decision, independent of whether a real sidecar process
    happens to be running); test_real_sidecar_classifies_a_benign_photo
    below additionally exercises the actual running sidecar in this dev
    session when reachable, skipping gracefully otherwise (same pattern as
    every other optional external dependency in this project)."""

    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    def _payload(self, **overrides):
        data = dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk)
        data.update(overrides)
        return data

    def test_real_sidecar_classifies_a_benign_photo(self):
        import requests

        try:
            requests.get("http://127.0.0.1:8801/health", timeout=1).raise_for_status()
        except Exception:
            self.skipTest("moderation-sidecar is not running in this environment")

        resp = self.client.post(
            "/api/needs/", self._payload(damage_photos=[make_test_image()]), format="multipart"
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        need = Need.objects.get(pk=resp.data["id"])
        photo = need.damage_photos.first()
        # A solid-color test image should score low and be auto-approved by the real model.
        self.assertEqual(photo.moderation_status, "approved")
        self.assertIsNotNone(resp.data["damage_photos"][0]["image"])  # approved -> visible

    def test_low_score_auto_approves_and_is_publicly_visible(self):
        from unittest.mock import patch

        with patch("core.views.moderate_image_field", return_value="approved"):
            resp = self.client.post(
                "/api/needs/", self._payload(damage_photos=[make_test_image()]), format="multipart"
            )
        self.assertEqual(resp.data["damage_photos"][0]["moderation_status"], "approved")
        self.assertIsNotNone(resp.data["damage_photos"][0]["image"])

    def test_high_score_auto_rejects_and_hides_image_url(self):
        from unittest.mock import patch

        with patch("core.views.moderate_image_field", return_value="rejected"):
            resp = self.client.post(
                "/api/needs/", self._payload(damage_photos=[make_test_image()]), format="multipart"
            )
        self.assertEqual(resp.data["damage_photos"][0]["moderation_status"], "rejected")
        self.assertIsNone(resp.data["damage_photos"][0]["image"])  # never visible once rejected

    def test_intermediate_score_goes_to_pending_queue_and_hides_image_url(self):
        from unittest.mock import patch

        with patch("core.views.moderate_image_field", return_value="pending"):
            resp = self.client.post(
                "/api/needs/", self._payload(damage_photos=[make_test_image()]), format="multipart"
            )
        self.assertEqual(resp.data["damage_photos"][0]["moderation_status"], "pending")
        self.assertIsNone(resp.data["damage_photos"][0]["image"])  # not published until a human approves

    def test_moderation_toggle_off_skips_check_and_auto_approves(self):
        from unittest.mock import patch

        config = AppConfiguration.get_solo()
        config.media_moderation_active = False
        config.save()
        with patch("core.moderation.classify_image_bytes") as mocked:
            resp = self.client.post(
                "/api/needs/", self._payload(damage_photos=[make_test_image()]), format="multipart"
            )
            mocked.assert_not_called()
        self.assertEqual(resp.data["damage_photos"][0]["moderation_status"], "approved")

    def test_sidecar_unreachable_queues_for_review_never_auto_approves(self):
        from unittest.mock import patch

        from core.moderation import ModerationUnavailable

        with patch("core.moderation.classify_image_bytes", side_effect=ModerationUnavailable("down")):
            resp = self.client.post(
                "/api/needs/", self._payload(damage_photos=[make_test_image()]), format="multipart"
            )
        self.assertEqual(resp.data["damage_photos"][0]["moderation_status"], "pending")

    def test_report_content_hides_it_immediately_independent_of_toggle(self):
        config = AppConfiguration.get_solo()
        config.media_moderation_active = False  # even with moderation off entirely
        config.save()
        from unittest.mock import patch

        with patch("core.views.moderate_image_field", return_value="approved"):
            need_resp = self.client.post(
                "/api/needs/", self._payload(damage_photos=[make_test_image()]), format="multipart"
            )
        photo_id = need_resp.data["damage_photos"][0]["id"]
        self.assertIsNotNone(need_resp.data["damage_photos"][0]["image"])

        report_resp = self.client.post(
            "/api/content-reports/",
            {"media_type": "damage_photo", "media_id": photo_id, "reporter_name": "A", "reporter_phone": "0600", "reason": "inappropriate"},
            format="json",
        )
        self.assertEqual(report_resp.status_code, 201, report_resp.content)

        need_resp2 = self.client.get(f"/api/needs/{need_resp.data['id']}/")
        self.assertIsNone(need_resp2.data["damage_photos"][0]["image"])  # hidden immediately

    def test_admin_moderation_action_is_logged(self):
        from unittest.mock import patch

        from core.models import AuditLog, DamagePhoto

        with patch("core.views.moderate_image_field", return_value="pending"):
            need_resp = self.client.post(
                "/api/needs/", self._payload(damage_photos=[make_test_image()]), format="multipart"
            )
        photo = DamagePhoto.objects.get(pk=need_resp.data["damage_photos"][0]["id"])
        admin = get_user_model().objects.create_superuser("modadmin", "m@example.com", "pw123456!")

        from core.admin import DamagePhotoAdmin, approve_media
        request = _fake_admin_request(admin)
        modeladmin = DamagePhotoAdmin(DamagePhoto, _admin_site())
        approve_media(modeladmin, request, DamagePhoto.objects.filter(pk=photo.pk))
        photo.refresh_from_db()
        self.assertEqual(photo.moderation_status, "approved")
        self.assertTrue(AuditLog.objects.filter(action="approved media").exists())


class DuplicateDetectionTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    def test_similar_need_suggested_within_24h_same_wilaya(self):
        first = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, title="Blankets urgently needed"),
            format="json",
        )
        resp = self.client.get(
            "/api/needs/check-duplicates/",
            {"wilaya": self.wilaya.pk, "title": "Blankets urgently needed", "description": NEED_PAYLOAD["location_description"]},
        )
        self.assertEqual(resp.status_code, 200)
        ids = [n["id"] for n in resp.data]
        self.assertIn(first.data["id"], ids)

    def test_suggestion_is_non_blocking_creation_still_succeeds(self):
        self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, title="Blankets urgently needed"),
            format="json",
        )
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, title="Blankets urgently needed"),
            format="json",
        )
        self.assertEqual(resp.status_code, 201)
        self.assertGreaterEqual(len(resp.data["duplicate_suggestions"]), 1)

    def test_different_wilaya_not_suggested(self):
        other_campaign = make_campaign()
        other_wilaya = other_campaign.authorized_wilayas.exclude(pk=self.wilaya.pk).first()
        self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, title="Blankets urgently needed"),
            format="json",
        )
        resp = self.client.get(
            "/api/needs/check-duplicates/",
            {"wilaya": other_wilaya.pk, "title": "Blankets urgently needed", "description": NEED_PAYLOAD["location_description"]},
        )
        self.assertEqual(resp.data, [])

    def test_report_as_duplicate_creates_report_and_admin_can_merge(self):
        from core.models import DuplicateReport

        original = self.client.post(
            "/api/needs/", dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk), format="json"
        )
        dup = self.client.post(
            "/api/needs/", dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk), format="json"
        )
        resp = self.client.post(
            f"/api/needs/{dup.data['id']}/report-duplicate/",
            {"reference_need_id": original.data["id"], "reporter_name": "Neighbor", "reporter_phone": "0611"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertTrue(DuplicateReport.objects.filter(reported_need_id=dup.data["id"]).exists())

        from core.admin import DuplicateReportAdmin, process_duplicate_merge

        admin = get_user_model().objects.create_superuser("dupadmin", "d@example.com", "pw123456!")
        request = _fake_admin_request(admin)
        modeladmin = DuplicateReportAdmin(DuplicateReport, _admin_site())
        process_duplicate_merge(modeladmin, request, DuplicateReport.objects.all())

        dup_need = Need.objects.get(pk=dup.data["id"])
        self.assertTrue(dup_need.is_cancelled)


class SupportRequestTests(BaseAPITestCase):
    def test_phone_alone_is_enough(self):
        resp = self.client.post("/api/support-requests/", {"requester_phone": "0555000001", "message": "help"}, format="json")
        self.assertEqual(resp.status_code, 201, resp.content)

    def test_email_alone_is_enough(self):
        resp = self.client.post("/api/support-requests/", {"requester_email": "a@example.com", "message": "help"}, format="json")
        self.assertEqual(resp.status_code, 201, resp.content)

    def test_neither_phone_nor_email_rejected(self):
        resp = self.client.post("/api/support-requests/", {"message": "help"}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_bug_report_category_stored(self):
        resp = self.client.post(
            "/api/support-requests/",
            {"category": "bug", "requester_email": "a@example.com", "message": "the map is blank on Firefox"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["category"], "bug")

    def test_category_defaults_to_general(self):
        resp = self.client.post("/api/support-requests/", {"requester_phone": "0555000001", "message": "help"}, format="json")
        self.assertEqual(resp.data["category"], "general")


class AppConfigurationEndpointTests(BaseAPITestCase):
    def test_admin_contact_fields_exposed_when_set(self):
        config = AppConfiguration.get_solo()
        config.admin_contact_email = "admin@example.com"
        config.save()
        AdminContactPhone.objects.create(config=config, phone="0555999999", label="WhatsApp")
        AdminContactPhone.objects.create(config=config, phone="0555888888")
        resp = self.client.get("/api/config/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["admin_contact_email"], "admin@example.com")
        self.assertEqual(
            resp.data["contact_phones"],
            [{"phone": "0555999999", "label": "WhatsApp"}, {"phone": "0555888888", "label": ""}],
        )

    def test_admin_contact_fields_blank_by_default(self):
        resp = self.client.get("/api/config/")
        self.assertEqual(resp.data["contact_phones"], [])
        self.assertEqual(resp.data["admin_contact_email"], "")

    def test_is_admin_false_for_anonymous(self):
        resp = self.client.get("/api/config/")
        self.assertFalse(resp.data["is_admin"])

    def test_is_admin_true_for_logged_in_staff(self):
        admin_user = get_user_model().objects.create_superuser("cfgadmin", "cfg@example.com", "pw123456!")
        self.client.force_authenticate(admin_user)
        resp = self.client.get("/api/config/")
        self.assertTrue(resp.data["is_admin"])

    def test_needs_open_count_excludes_covered_and_cancelled(self):
        campaign = make_campaign()
        wilaya = campaign.authorized_wilayas.first()
        common = dict(contact_name="A", contact_phone="0555000000", wilaya=wilaya, campaign=campaign)
        Need.objects.create(title="Open one", overall_status=Need.STATUS_OPEN, **common)
        Need.objects.create(title="Partially covered", overall_status=Need.STATUS_PARTIALLY_COVERED, **common)
        Need.objects.create(title="Covered", overall_status=Need.STATUS_COVERED, **common)
        Need.objects.create(title="Cancelled", overall_status=Need.STATUS_CANCELLED, **common)
        resp = self.client.get("/api/config/")
        self.assertEqual(resp.data["needs_open_count"], 2)

    def test_collection_points_active_count_excludes_closed(self):
        wilaya = Wilaya.objects.first()
        common = dict(point_name="P", contact_name="A", contact_phone="0555000000", wilaya=wilaya, location_description="Somewhere")
        CollectionPoint.objects.create(status=CollectionPoint.STATUS_ACTIVE, **common)
        CollectionPoint.objects.create(status=CollectionPoint.STATUS_ACTIVE, **common)
        CollectionPoint.objects.create(status=CollectionPoint.STATUS_CLOSED, **common)
        resp = self.client.get("/api/config/")
        self.assertEqual(resp.data["collection_points_active_count"], 2)

    def test_deliveries_en_route_count_excludes_delivered_and_cancelled(self):
        campaign = make_campaign()
        wilaya = campaign.authorized_wilayas.first()
        need = Need.objects.create(
            title="Blankets", contact_name="A", contact_phone="0555000000", wilaya=wilaya, campaign=campaign
        )
        common = dict(need=need, responder_type=Pickup.RESPONDER_INDIVIDUAL, responder_name="B", responder_phone="0555111111")
        Pickup.objects.create(status=Pickup.STATUS_EN_ROUTE, **common)
        Pickup.objects.create(status=Pickup.STATUS_EN_ROUTE, **common)
        Pickup.objects.create(status=Pickup.STATUS_DELIVERED, **common)
        Pickup.objects.create(status=Pickup.STATUS_CANCELLED, **common)
        resp = self.client.get("/api/config/")
        self.assertEqual(resp.data["deliveries_en_route_count"], 2)

    def test_at_most_5_contact_phones_enforced_in_admin(self):
        config = AppConfiguration.get_solo()
        for i in range(5):
            AdminContactPhone.objects.create(config=config, phone=f"055500000{i}")
        from django.test import Client as DjangoClient

        admin_user = get_user_model().objects.create_superuser("admin4", "a4@example.com", "pw123456!")
        django_client = DjangoClient()
        django_client.force_login(admin_user)
        response = django_client.get(f"/admin/core/appconfiguration/{config.pk}/change/")
        # max_num=5 with 5 existing rows leaves no empty "extra" form to add a 6th.
        self.assertEqual(response.context["inline_admin_formsets"][0].formset.extra_forms, [])


class TranslationOverridesTests(BaseAPITestCase):
    def test_empty_by_default_but_all_locales_present(self):
        resp = self.client.get("/api/translations/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data, {"fr": {}, "en": {}, "ar": {}})

    def test_dotted_key_becomes_nested_tree(self):
        TranslationOverride.objects.create(locale="fr", key="home.tagline", value="Texte corrigé")
        resp = self.client.get("/api/translations/")
        self.assertEqual(resp.data["fr"], {"home": {"tagline": "Texte corrigé"}})

    def test_multiple_keys_same_branch_merge_into_one_tree(self):
        TranslationOverride.objects.create(locale="fr", key="createNeed.name", value="Nom")
        TranslationOverride.objects.create(locale="fr", key="createNeed.phone", value="Tél.")
        resp = self.client.get("/api/translations/")
        self.assertEqual(resp.data["fr"], {"createNeed": {"name": "Nom", "phone": "Tél."}})

    def test_locales_are_independent(self):
        TranslationOverride.objects.create(locale="fr", key="home.tagline", value="FR text")
        TranslationOverride.objects.create(locale="en", key="home.tagline", value="EN text")
        resp = self.client.get("/api/translations/")
        self.assertEqual(resp.data["fr"]["home"]["tagline"], "FR text")
        self.assertEqual(resp.data["en"]["home"]["tagline"], "EN text")
        self.assertEqual(resp.data["ar"], {})


class ReverseGeocodeTests(BaseAPITestCase):
    def test_nearest_wilaya_returned_for_coordinates(self):
        # Algiers coordinates -- should resolve to wilaya "Alger" (16).
        resp = self.client.get("/api/wilayas/nearest/", {"lat": 36.75, "lon": 3.06})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["name"], "Alger")

    def test_missing_params_rejected_clearly(self):
        resp = self.client.get("/api/wilayas/nearest/")
        self.assertEqual(resp.status_code, 400)


class GPSBoundingBoxTests(BaseAPITestCase):
    """Re-confirms the Algeria bounding-box check (built in Wave 1 ahead of
    this wave's spec text) is distinct from, and coexists with, the
    Wave 1 IP-based write restriction."""

    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    def test_paris_coordinates_rejected_with_graceful_fallback_not_hard_error(self):
        resp = self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, latitude=48.85, longitude=2.35),
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Algeria", str(resp.data))  # a clear message, not a silent/500 failure

    def test_same_request_without_gps_succeeds(self):
        # Confirms rejection falls back gracefully to manual entry rather
        # than failing the whole form.
        payload = dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk)
        resp = self.client.post("/api/needs/", payload, format="json")
        self.assertEqual(resp.status_code, 201)


COLLECTION_POINT_PAYLOAD = {
    "point_name": "Mosque el Nour collection point",
    "contact_name": "Yacine",
    "contact_phone": "0555222222",
    "organization": "Local mosque committee",
    "location_description": "Next to the main mosque",
    "hours": "8am-6pm daily",
}


class CollectionPointTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.wilaya = Wilaya.objects.first()

    def _payload(self, **overrides):
        data = dict(COLLECTION_POINT_PAYLOAD, wilaya=self.wilaya.pk)
        data.update(overrides)
        return data

    def test_anyone_can_create_no_admin_restriction(self):
        resp = self.client.post("/api/collection-points/", self._payload(), format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["status"], "active")

    def test_filterable_by_wilaya_like_needs(self):
        other_wilaya = Wilaya.objects.exclude(pk=self.wilaya.pk).first()
        self.client.post("/api/collection-points/", self._payload(), format="json")
        self.client.post("/api/collection-points/", self._payload(wilaya=other_wilaya.pk), format="json")
        resp = self.client.get(f"/api/collection-points/?wilaya={self.wilaya.pk}")
        self.assertEqual(len(resp.data["results"]), 1)

    def test_appears_on_locations_endpoint_with_centroid_fallback(self):
        self.client.post("/api/collection-points/", self._payload(), format="json")
        resp = self.client.get("/api/collection-points/locations/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertFalse(resp.data[0]["has_exact_position"])
        self.assertIsNotNone(resp.data[0]["display_latitude"])

    def test_closed_points_excluded_from_locations(self):
        create_resp = self.client.post("/api/collection-points/", self._payload(), format="json")
        self.client.post(
            f"/api/collection-points/{create_resp.data['id']}/close/",
            {"contact_name": COLLECTION_POINT_PAYLOAD["contact_name"], "contact_phone": COLLECTION_POINT_PAYLOAD["contact_phone"]},
            format="json",
        )
        resp = self.client.get("/api/collection-points/locations/")
        self.assertEqual(resp.data, [])

    def test_search_matches_point_name_and_description(self):
        self.client.post("/api/collection-points/", self._payload(point_name="Mosquée El Kheir"), format="json")
        self.client.post("/api/collection-points/", self._payload(point_name="Autre point"), format="json")
        resp = self.client.get("/api/collection-points/?search=Kheir")
        self.assertEqual(len(resp.data["results"]), 1)
        self.assertEqual(resp.data["results"][0]["point_name"], "Mosquée El Kheir")

    def test_creator_can_close_with_matching_name_phone(self):
        create_resp = self.client.post("/api/collection-points/", self._payload(), format="json")
        resp = self.client.post(
            f"/api/collection-points/{create_resp.data['id']}/close/",
            {"contact_name": COLLECTION_POINT_PAYLOAD["contact_name"], "contact_phone": COLLECTION_POINT_PAYLOAD["contact_phone"]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["status"], "closed")

    def test_close_rejected_with_wrong_name_phone(self):
        create_resp = self.client.post("/api/collection-points/", self._payload(), format="json")
        resp = self.client.post(
            f"/api/collection-points/{create_resp.data['id']}/close/",
            {"contact_name": "Someone Else", "contact_phone": "0000000000"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)


class CollectionPointFlyerTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.wilaya = Wilaya.objects.first()

    def _payload(self, **overrides):
        data = dict(COLLECTION_POINT_PAYLOAD, wilaya=self.wilaya.pk)
        data.update(overrides)
        return data

    def test_create_without_flyer_still_works(self):
        resp = self.client.post("/api/collection-points/", self._payload(), format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertIsNone(resp.data["flyer_image"])
        # Never-set flyer defaults to approved -- an absent flyer must never
        # look like a pending/rejected one on an otherwise-ordinary point.
        self.assertEqual(resp.data["flyer_moderation_status"], "approved")

    def test_create_with_flyer_auto_approved_is_visible(self):
        from unittest.mock import patch

        with patch("core.views.moderate_image_field", return_value="approved"):
            resp = self.client.post(
                "/api/collection-points/", self._payload(flyer_image=make_test_image()), format="multipart"
            )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["flyer_moderation_status"], "approved")
        self.assertIsNotNone(resp.data["flyer_image"])

    def test_flyer_oversized_rejected(self):
        from django.core.files.uploadedfile import SimpleUploadedFile

        from core.media_validation import MAX_PHOTO_SIZE_BYTES

        oversized = SimpleUploadedFile("big.jpg", b"x" * (MAX_PHOTO_SIZE_BYTES + 1), content_type="image/jpeg")
        resp = self.client.post("/api/collection-points/", self._payload(flyer_image=oversized), format="multipart")
        self.assertEqual(resp.status_code, 400)

    def test_flyer_pending_hides_image_url(self):
        from unittest.mock import patch

        with patch("core.views.moderate_image_field", return_value="pending"):
            resp = self.client.post(
                "/api/collection-points/", self._payload(flyer_image=make_test_image()), format="multipart"
            )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["flyer_moderation_status"], "pending")
        self.assertIsNone(resp.data["flyer_image"])

    def test_flyer_rejected_hides_image_url(self):
        from unittest.mock import patch

        with patch("core.views.moderate_image_field", return_value="rejected"):
            resp = self.client.post(
                "/api/collection-points/", self._payload(flyer_image=make_test_image()), format="multipart"
            )
        self.assertEqual(resp.data["flyer_moderation_status"], "rejected")
        self.assertIsNone(resp.data["flyer_image"])

    def test_report_flyer_hides_it_immediately(self):
        from unittest.mock import patch

        with patch("core.views.moderate_image_field", return_value="approved"):
            create_resp = self.client.post(
                "/api/collection-points/", self._payload(flyer_image=make_test_image()), format="multipart"
            )
        point_id = create_resp.data["id"]
        self.assertIsNotNone(create_resp.data["flyer_image"])

        report_resp = self.client.post(
            "/api/content-reports/",
            {"media_type": "collection_point_flyer", "media_id": point_id, "reporter_name": "A", "reporter_phone": "0600", "reason": "inappropriate"},
            format="json",
        )
        self.assertEqual(report_resp.status_code, 201, report_resp.content)

        point_resp2 = self.client.get(f"/api/collection-points/{point_id}/")
        self.assertIsNone(point_resp2.data["flyer_image"])  # hidden immediately, before any admin review

    def test_existing_collection_point_without_flyer_still_readable(self):
        # Backward-compat: a point created before this field existed (no
        # flyer ever attempted) must still serialize cleanly.
        point = CollectionPoint.objects.create(**self._payload(wilaya=self.wilaya))
        resp = self.client.get(f"/api/collection-points/{point.id}/")
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.data["flyer_image"])

    def test_admin_approve_flyer_action_is_logged(self):
        from unittest.mock import patch

        from core.admin import CollectionPointAdmin, approve_flyer
        from core.models import AuditLog

        with patch("core.views.moderate_image_field", return_value="pending"):
            resp = self.client.post(
                "/api/collection-points/", self._payload(flyer_image=make_test_image()), format="multipart"
            )
        point = CollectionPoint.objects.get(pk=resp.data["id"])
        self.assertEqual(point.flyer_moderation_status, "pending")
        admin = get_user_model().objects.create_superuser("cpadmin", "cp@example.com", "pw123456!")

        request = _fake_admin_request(admin)
        modeladmin = CollectionPointAdmin(CollectionPoint, _admin_site())
        approve_flyer(modeladmin, request, CollectionPoint.objects.filter(pk=point.pk))
        point.refresh_from_db()
        self.assertEqual(point.flyer_moderation_status, "approved")
        self.assertEqual(point.flyer_moderated_by, "admin")
        self.assertTrue(AuditLog.objects.filter(action="approved flyer").exists())

    def test_admin_reject_flyer_action_is_logged(self):
        from unittest.mock import patch

        from core.admin import CollectionPointAdmin, reject_flyer
        from core.models import AuditLog

        with patch("core.views.moderate_image_field", return_value="pending"):
            resp = self.client.post(
                "/api/collection-points/", self._payload(flyer_image=make_test_image()), format="multipart"
            )
        point = CollectionPoint.objects.get(pk=resp.data["id"])
        admin = get_user_model().objects.create_superuser("cpadmin2", "cp2@example.com", "pw123456!")

        request = _fake_admin_request(admin)
        modeladmin = CollectionPointAdmin(CollectionPoint, _admin_site())
        reject_flyer(modeladmin, request, CollectionPoint.objects.filter(pk=point.pk))
        point.refresh_from_db()
        self.assertEqual(point.flyer_moderation_status, "rejected")
        self.assertEqual(point.flyer_moderated_by, "admin")
        self.assertTrue(AuditLog.objects.filter(action="rejected flyer").exists())

    def test_admin_restore_content_handles_collection_point_flyer(self):
        # restore_content/confirm_content_rejection (used for ContentReport
        # review) branch on the reported object's type -- this is the
        # CollectionPoint branch specifically, added alongside the flyer
        # feature (see core/admin.py).
        from unittest.mock import patch

        from core.admin import ContentReportAdmin, restore_content
        from core.models import ContentReport

        with patch("core.views.moderate_image_field", return_value="approved"):
            create_resp = self.client.post(
                "/api/collection-points/", self._payload(flyer_image=make_test_image()), format="multipart"
            )
        point_id = create_resp.data["id"]
        self.client.post(
            "/api/content-reports/",
            {"media_type": "collection_point_flyer", "media_id": point_id, "reporter_name": "A", "reporter_phone": "0600", "reason": "inappropriate"},
            format="json",
        )
        point = CollectionPoint.objects.get(pk=point_id)
        self.assertEqual(point.flyer_moderation_status, "pending")  # hidden immediately by the report

        admin = get_user_model().objects.create_superuser("cpadmin3", "cp3@example.com", "pw123456!")
        request = _fake_admin_request(admin)
        modeladmin = ContentReportAdmin(ContentReport, _admin_site())
        report = ContentReport.objects.get(media_type="collection_point_flyer", media_id=point_id)
        restore_content(modeladmin, request, ContentReport.objects.filter(pk=report.pk))
        point.refresh_from_db()
        self.assertEqual(point.flyer_moderation_status, "approved")
        self.assertEqual(point.flyer_moderated_by, "admin")


class CollectionPointSocialLinksTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.wilaya = Wilaya.objects.first()

    def _payload(self, **overrides):
        data = dict(COLLECTION_POINT_PAYLOAD, wilaya=self.wilaya.pk)
        data.update(overrides)
        return data

    def test_create_without_any_social_link(self):
        resp = self.client.post("/api/collection-points/", self._payload(), format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["facebook_url"], "")
        self.assertEqual(resp.data["tiktok_url"], "")
        self.assertEqual(resp.data["instagram_url"], "")

    def test_create_with_facebook_only(self):
        resp = self.client.post(
            "/api/collection-points/", self._payload(facebook_url="https://facebook.com/example"), format="json"
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["facebook_url"], "https://facebook.com/example")
        self.assertEqual(resp.data["tiktok_url"], "")
        self.assertEqual(resp.data["instagram_url"], "")

    def test_create_with_all_three_social_links(self):
        resp = self.client.post(
            "/api/collection-points/",
            self._payload(
                facebook_url="https://facebook.com/example",
                tiktok_url="https://tiktok.com/@example",
                instagram_url="https://instagram.com/example",
            ),
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["facebook_url"], "https://facebook.com/example")
        self.assertEqual(resp.data["tiktok_url"], "https://tiktok.com/@example")
        self.assertEqual(resp.data["instagram_url"], "https://instagram.com/example")

    def test_non_http_scheme_rejected(self):
        for field in ["facebook_url", "tiktok_url", "instagram_url"]:
            resp = self.client.post(
                "/api/collection-points/", self._payload(**{field: "javascript:alert(1)"}), format="json"
            )
            self.assertEqual(resp.status_code, 400, resp.content)
            self.assertIn(field, resp.data)

    def test_ftp_scheme_rejected(self):
        resp = self.client.post(
            "/api/collection-points/", self._payload(facebook_url="ftp://example.com/page"), format="json"
        )
        self.assertEqual(resp.status_code, 400, resp.content)

    def test_social_links_returned_in_detail(self):
        create_resp = self.client.post(
            "/api/collection-points/", self._payload(instagram_url="https://instagram.com/example"), format="json"
        )
        resp = self.client.get(f"/api/collection-points/{create_resp.data['id']}/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["instagram_url"], "https://instagram.com/example")
        self.assertEqual(resp.data["facebook_url"], "")

    def test_existing_collection_point_without_social_links_still_readable(self):
        """A CollectionPoint created (or migrated) before these fields
        existed must remain fully readable -- backward compatibility, not
        just "new writes work"."""
        point = CollectionPoint.objects.create(
            wilaya=self.wilaya,
            point_name="Old point",
            contact_name="Yacine",
            contact_phone="0555222222",
            location_description="Somewhere",
        )
        resp = self.client.get(f"/api/collection-points/{point.id}/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["facebook_url"], "")
        self.assertEqual(resp.data["tiktok_url"], "")
        self.assertEqual(resp.data["instagram_url"], "")


class CollectionPointDonationsAndOtherPhonesTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.wilaya = Wilaya.objects.first()

    def _payload(self, **overrides):
        data = dict(COLLECTION_POINT_PAYLOAD, wilaya=self.wilaya.pk)
        data.update(overrides)
        return data

    def test_create_without_donations_or_other_phones(self):
        resp = self.client.post("/api/collection-points/", self._payload(), format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["accepted_donations"], "")
        self.assertEqual(resp.data["other_phones"], "")

    def test_create_with_accepted_donations_free_text(self):
        resp = self.client.post(
            "/api/collection-points/",
            self._payload(accepted_donations="Couvertures, eau, conserves"),
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["accepted_donations"], "Couvertures, eau, conserves")

    def test_create_with_multiple_other_phones_with_line_breaks(self):
        numbers = "0555111111\n0555222222\n0555333333"
        resp = self.client.post("/api/collection-points/", self._payload(other_phones=numbers), format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.data["other_phones"], numbers)

    def test_other_phones_does_not_affect_close_identity_match(self):
        """other_phones is purely informational -- matches_creator (used by
        the self-service close endpoint) must keep matching on contact_phone
        alone, regardless of what's in other_phones."""
        create_resp = self.client.post(
            "/api/collection-points/", self._payload(other_phones="0555999999"), format="json"
        )
        resp = self.client.post(
            f"/api/collection-points/{create_resp.data['id']}/close/",
            {"contact_name": COLLECTION_POINT_PAYLOAD["contact_name"], "contact_phone": COLLECTION_POINT_PAYLOAD["contact_phone"]},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["status"], "closed")

    def test_returned_in_detail(self):
        create_resp = self.client.post(
            "/api/collection-points/",
            self._payload(accepted_donations="Vêtements chauds", other_phones="0555444444\n0555555555"),
            format="json",
        )
        resp = self.client.get(f"/api/collection-points/{create_resp.data['id']}/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["accepted_donations"], "Vêtements chauds")
        self.assertEqual(resp.data["other_phones"], "0555444444\n0555555555")

    def test_existing_collection_point_without_these_fields_still_readable(self):
        point = CollectionPoint.objects.create(
            wilaya=self.wilaya,
            point_name="Old point",
            contact_name="Yacine",
            contact_phone="0555222222",
            location_description="Somewhere",
        )
        resp = self.client.get(f"/api/collection-points/{point.id}/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["accepted_donations"], "")
        self.assertEqual(resp.data["other_phones"], "")


class PickupLiveLocationsTests(BaseAPITestCase):
    """The aggregate, public "all couriers en route" map -- distinct from
    (and deliberately less restricted than) MapAndLocationPrivacyTests'
    access-controlled per-need pickup-locations endpoint. See
    LocationPing's docstring for the product decision behind this."""

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

    def _make_pickup(self, status=None, sharing=True, ping=True):
        pickup_resp = self.client.post(
            "/api/pickups/",
            {
                "need": self.need_id,
                "responder_type": "individual_volunteer",
                "responder_name": "Sara Amrani",
                "responder_phone": "0666000002",
                "content_brought": "30 blankets",
            },
            format="json",
        )
        pickup_id = pickup_resp.data["id"]
        token = pickup_resp.data["access_token"]
        if ping:
            # Submitting a ping always flips location_sharing_active on as
            # a side effect (see add_location_ping) -- so to test the
            # "sharing later turned off, stale ping still on record" case,
            # the opt-out PATCH has to come after the ping, not before.
            self.client.post(
                f"/api/pickups/{pickup_id}/location-pings/",
                {"latitude": 36.75, "longitude": 3.04, "access_token": token},
                format="json",
            )
        if not sharing:
            self.client.patch(
                f"/api/pickups/{pickup_id}/",
                {"location_sharing_active": False, "access_token": token},
                format="json",
            )
        if status is not None:
            pickup = Pickup.objects.get(pk=pickup_id)
            pickup.status = status
            pickup.save(update_fields=["status"])
        return pickup_id, token

    def test_visible_to_anonymous_visitor_no_auth_needed(self):
        self._make_pickup()
        resp = self.client.get("/api/pickups/live-locations/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data), 1)
        self.assertEqual(resp.data[0]["latitude"], 36.75)
        self.assertEqual(resp.data[0]["need_id"], self.need_id)

    def test_excludes_pickup_with_sharing_off(self):
        self._make_pickup(sharing=False)
        resp = self.client.get("/api/pickups/live-locations/")
        self.assertEqual(resp.data, [])

    def test_excludes_delivered_pickup(self):
        self._make_pickup(status=Pickup.STATUS_DELIVERED)
        resp = self.client.get("/api/pickups/live-locations/")
        self.assertEqual(resp.data, [])

    def test_excludes_cancelled_pickup(self):
        self._make_pickup(status=Pickup.STATUS_CANCELLED)
        resp = self.client.get("/api/pickups/live-locations/")
        self.assertEqual(resp.data, [])

    def test_excludes_pickup_with_no_ping_yet(self):
        self._make_pickup(ping=False)
        resp = self.client.get("/api/pickups/live-locations/")
        self.assertEqual(resp.data, [])

    def test_deliver_clears_location_sharing(self):
        # location_sharing_active must be turned off the instant a delivery
        # is marked delivered, not just filtered out of live-locations by
        # status alone -- a courier who re-opts-in on a future delivery
        # should start from a clean, explicit consent state.
        pickup_id, token = self._make_pickup()
        self.assertTrue(Pickup.objects.get(pk=pickup_id).location_sharing_active)
        resp = self.client.post(f"/api/pickups/{pickup_id}/deliver/", {"access_token": token}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(Pickup.objects.get(pk=pickup_id).location_sharing_active)

    def test_cancel_clears_location_sharing(self):
        pickup_id, token = self._make_pickup()
        self.assertTrue(Pickup.objects.get(pk=pickup_id).location_sharing_active)
        resp = self.client.patch(
            f"/api/pickups/{pickup_id}/", {"is_cancelled": True, "access_token": token}, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(Pickup.objects.get(pk=pickup_id).location_sharing_active)

    def test_ping_rejected_after_delivered(self):
        pickup_id, token = self._make_pickup()
        self.client.post(f"/api/pickups/{pickup_id}/deliver/", {"access_token": token}, format="json")
        resp = self.client.post(
            f"/api/pickups/{pickup_id}/location-pings/",
            {"latitude": 36.8, "longitude": 3.1, "access_token": token},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)
        # And it genuinely wasn't recorded either, not just hidden from the map.
        from core.models import LocationPing

        self.assertEqual(LocationPing.objects.filter(pickup_id=pickup_id, latitude=36.8).count(), 0)

    def test_ping_rejected_after_cancelled(self):
        pickup_id, token = self._make_pickup()
        self.client.patch(f"/api/pickups/{pickup_id}/", {"is_cancelled": True, "access_token": token}, format="json")
        resp = self.client.post(
            f"/api/pickups/{pickup_id}/location-pings/",
            {"latitude": 36.8, "longitude": 3.1, "access_token": token},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_returns_latest_ping_not_oldest(self):
        pickup_id, token = self._make_pickup()
        self.client.post(
            f"/api/pickups/{pickup_id}/location-pings/",
            {"latitude": 37.0, "longitude": 3.5, "access_token": token},
            format="json",
        )
        resp = self.client.get("/api/pickups/live-locations/")
        self.assertEqual(len(resp.data), 1)
        self.assertEqual(resp.data[0]["latitude"], 37.0)


class SearchFilterTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()

    def test_need_search_matches_title_and_description(self):
        self.client.post("/api/needs/", dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, title="Couvertures"), format="json")
        self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, title="Eau potable", location_description="Besoin urgent"),
            format="json",
        )
        resp = self.client.get("/api/needs/?search=Couvertures")
        self.assertEqual(len(resp.data["results"]), 1)
        self.assertEqual(resp.data["results"][0]["title"], "Couvertures")

    def test_need_search_is_case_insensitive_and_matches_description(self):
        self.client.post(
            "/api/needs/",
            dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk, location_description="Near the old bakery"),
            format="json",
        )
        resp = self.client.get("/api/needs/?search=bakery")
        self.assertEqual(len(resp.data["results"]), 1)

    def test_pickup_search_matches_responder_name(self):
        need_resp = self.client.post("/api/needs/", dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk), format="json")
        self.client.post(
            "/api/pickups/",
            {
                "need": need_resp.data["id"],
                "responder_type": "individual_volunteer",
                "responder_name": "Yacine Volunteer",
                "responder_phone": "0666000009",
                "content_brought": "Water",
            },
            format="json",
        )
        resp = self.client.get("/api/pickups/?search=Yacine")
        self.assertEqual(len(resp.data["results"]), 1)


class CommentTests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        self.campaign = make_campaign()
        self.wilaya = self.campaign.authorized_wilayas.first()
        need_resp = self.client.post(
            "/api/needs/", dict(NEED_PAYLOAD, campaign=self.campaign.pk, wilaya=self.wilaya.pk), format="json"
        )
        self.need_id = need_resp.data["id"]

    def _comment_payload(self, **overrides):
        data = {"need": self.need_id, "author_name": "Villager", "text": "Any update?"}
        data.update(overrides)
        return data

    def test_create_root_comment_on_need(self):
        resp = self.client.post("/api/comments/", self._comment_payload(), format="json")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertNotIn("author_phone", resp.data)  # never shown publicly
        self.assertIn("owner_token", resp.data)  # returned once, to the author only

    def test_comment_creation_does_not_require_phone(self):
        resp = self.client.post("/api/comments/", {"need": self.need_id, "author_name": "Villager", "text": "No phone given"}, format="json")
        self.assertEqual(resp.status_code, 201, resp.content)

    def test_reply_one_level_only(self):
        root = self.client.post("/api/comments/", self._comment_payload(), format="json")
        reply = self.client.post(
            "/api/comments/",
            self._comment_payload(parent_comment=root.data["id"], text="Yes, on the way"),
            format="json",
        )
        self.assertEqual(reply.status_code, 201)

        double_reply = self.client.post(
            "/api/comments/",
            self._comment_payload(parent_comment=reply.data["id"], text="nested too deep"),
            format="json",
        )
        self.assertEqual(double_reply.status_code, 400)

    def test_reply_appears_nested_under_root_in_need_detail(self):
        root = self.client.post("/api/comments/", self._comment_payload(), format="json")
        self.client.post(
            "/api/comments/",
            self._comment_payload(parent_comment=root.data["id"], text="Yes, on the way"),
            format="json",
        )
        need = self.client.get(f"/api/needs/{self.need_id}/")
        self.assertEqual(len(need.data["comments"]), 1)  # one root comment
        self.assertEqual(len(need.data["comments"][0]["replies"]), 1)
        self.assertEqual(need.data["comments"][0]["replies"][0]["text"], "Yes, on the way")

    def test_confirm_increments_and_persists(self):
        root = self.client.post("/api/comments/", self._comment_payload(), format="json")
        r1 = self.client.post(f"/api/comments/{root.data['id']}/confirm/")
        r2 = self.client.post(f"/api/comments/{root.data['id']}/confirm/")
        self.assertEqual(r2.data["confirmation_count"], 2)
        from core.models import Comment

        self.assertEqual(Comment.objects.get(pk=root.data["id"]).confirmation_count, 2)

    def test_author_can_delete_own_comment(self):
        root = self.client.post("/api/comments/", self._comment_payload(), format="json")
        resp = self.client.delete(
            f"/api/comments/{root.data['id']}/",
            {"owner_token": root.data["owner_token"]},
            format="json",
        )
        self.assertEqual(resp.status_code, 204)

    def test_delete_rejected_with_wrong_token(self):
        root = self.client.post("/api/comments/", self._comment_payload(), format="json")
        resp = self.client.delete(
            f"/api/comments/{root.data['id']}/",
            {"owner_token": "wrong-token"},
            format="json",
        )
        self.assertEqual(resp.status_code, 403)

    def test_admin_can_delete_any_comment_logged(self):
        from core.models import AuditLog

        root = self.client.post("/api/comments/", self._comment_payload(), format="json")
        admin = get_user_model().objects.create_superuser("commentadmin", "c@example.com", "pw123456!")
        self.client.force_authenticate(admin)
        resp = self.client.delete(f"/api/comments/{root.data['id']}/", {}, format="json")
        self.assertEqual(resp.status_code, 204)
        self.assertTrue(AuditLog.objects.filter(action="deleted comment").exists())

    def test_comment_on_collection_point(self):
        cp_resp = self.client.post(
            "/api/collection-points/", dict(COLLECTION_POINT_PAYLOAD, wilaya=self.wilaya.pk), format="json"
        )
        resp = self.client.post(
            "/api/comments/",
            {"collection_point": cp_resp.data["id"], "author_name": "X", "author_phone": "0600", "text": "Great spot"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)

        detail = self.client.get(f"/api/collection-points/{cp_resp.data['id']}/")
        self.assertEqual(len(detail.data["comments"]), 1)

    def test_must_target_exactly_one_of_need_or_collection_point(self):
        resp = self.client.post(
            "/api/comments/",
            {"author_name": "X", "author_phone": "0600", "text": "orphan comment"},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_read_only_mode_blocks_comment_creation(self):
        config = AppConfiguration.get_solo()
        config.mode = AppConfiguration.MODE_READ_ONLY
        config.save()
        resp = self.client.post("/api/comments/", self._comment_payload(), format="json")
        self.assertEqual(resp.status_code, 403)

    def test_rate_limit_applies_to_comment_creation(self):
        # The rate limit is shared across all creation endpoints for a given
        # IP (one "creation" throttle scope) -- setUp already used one slot
        # creating the Need these comments attach to.
        from django.conf import settings

        remaining = settings.RATE_LIMIT_CREATIONS_PER_HOUR - 1
        for i in range(remaining):
            resp = self.client.post("/api/comments/", self._comment_payload(text=f"msg {i}"), format="json")
            self.assertEqual(resp.status_code, 201)
        resp = self.client.post("/api/comments/", self._comment_payload(text="one too many"), format="json")
        self.assertEqual(resp.status_code, 429)


class CollectionPointRateLimitTest(BaseAPITestCase):
    def test_rate_limit_applies_to_collection_point_creation(self):
        from django.conf import settings

        wilaya = Wilaya.objects.first()
        limit = settings.RATE_LIMIT_CREATIONS_PER_HOUR
        for i in range(limit):
            resp = self.client.post(
                "/api/collection-points/",
                dict(COLLECTION_POINT_PAYLOAD, wilaya=wilaya.pk, point_name=f"Point {i}"),
                format="json",
            )
            self.assertEqual(resp.status_code, 201)
        resp = self.client.post(
            "/api/collection-points/", dict(COLLECTION_POINT_PAYLOAD, wilaya=wilaya.pk), format="json"
        )
        self.assertEqual(resp.status_code, 429)


class VideoDurationValidationTests(TestCase):
    """Unit-level coverage of core/media_validation.py's fail-closed
    behavior, requested in PR review: the 20s video cap must hold
    server-side even when ffprobe is unavailable or errors, not just when
    it successfully reports an over-long duration. This behavior is gated
    behind AppConfiguration.enforce_video_duration_check (off by default,
    see AppConfigurationEndpointTests/PickupAndStatusTests for that
    default-off behavior) -- these tests are specifically about the
    strict-mode code path, so they turn it on."""

    def setUp(self):
        from core.models import AppConfiguration

        config = AppConfiguration.get_solo()
        config.enforce_video_duration_check = True
        config.save()

    def test_rejects_when_ffprobe_not_on_path(self):
        from unittest.mock import patch
        from rest_framework import serializers as drf_serializers
        from core.media_validation import validate_video_duration
        from django.core.files.uploadedfile import SimpleUploadedFile

        video = SimpleUploadedFile("clip.webm", b"fake-video-bytes", content_type="video/webm")
        with patch("core.media_validation.ffprobe_available", return_value=False):
            with self.assertRaises(drf_serializers.ValidationError):
                validate_video_duration(video)

    def test_rejects_when_ffprobe_available_but_errors(self):
        """Distinct from ffprobe being missing entirely: here it's on PATH
        but the subprocess call itself fails (corrupt file, timeout,
        unexpected output) -- must still fail closed, not accept."""
        from unittest.mock import patch
        from rest_framework import serializers as drf_serializers
        from core.media_validation import validate_video_duration
        from django.core.files.uploadedfile import SimpleUploadedFile

        video = SimpleUploadedFile("clip.webm", b"fake-video-bytes", content_type="video/webm")
        with patch("core.media_validation.ffprobe_available", return_value=True), \
                patch("core.media_validation.subprocess.run", side_effect=OSError("boom")):
            with self.assertRaises(drf_serializers.ValidationError):
                validate_video_duration(video)

    def test_rejects_when_duration_exceeds_cap(self):
        from unittest.mock import patch
        from rest_framework import serializers as drf_serializers
        from core.media_validation import validate_video_duration
        from django.core.files.uploadedfile import SimpleUploadedFile

        video = SimpleUploadedFile("clip.webm", b"fake-video-bytes", content_type="video/webm")
        with patch("core.media_validation.get_video_duration_seconds", return_value=35.0):
            with self.assertRaises(drf_serializers.ValidationError):
                validate_video_duration(video)

    def test_accepts_when_duration_within_cap(self):
        from core.media_validation import validate_video_duration
        from django.core.files.uploadedfile import SimpleUploadedFile

        video = SimpleUploadedFile("clip.webm", b"fake-video-bytes", content_type="video/webm")
        from unittest.mock import patch

        with patch("core.media_validation.get_video_duration_seconds", return_value=15.0):
            validate_video_duration(video)  # should not raise

    def test_no_op_when_check_disabled(self):
        """The default-off case, overriding this class's own setUp: even
        an over-long, unverifiable video is a no-op when the admin setting
        is off -- see test_video_accepted_by_default_even_when_duration_undeterminable
        for the same behavior exercised through the actual API."""
        from unittest.mock import patch
        from core.media_validation import validate_video_duration
        from core.models import AppConfiguration
        from django.core.files.uploadedfile import SimpleUploadedFile

        config = AppConfiguration.get_solo()
        config.enforce_video_duration_check = False
        config.save()
        video = SimpleUploadedFile("clip.webm", b"fake-video-bytes", content_type="video/webm")
        with patch("core.media_validation.ffprobe_available", return_value=False):
            validate_video_duration(video)  # should not raise
