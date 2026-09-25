import shutil
import tempfile
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings

from core.models import AppConfiguration, Need, Signalement, Wilaya
from core.signalements import process_signalement
from core.tests import BaseAPITestCase, make_test_image
from core.voice_ai import VoiceAIError

MEDIA_ROOT = tempfile.mkdtemp()


@override_settings(MEDIA_ROOT=MEDIA_ROOT)
class SignalementAPITests(BaseAPITestCase):
    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        shutil.rmtree(MEDIA_ROOT, ignore_errors=True)

    def setUp(self):
        super().setUp()
        self.wilaya = Wilaya.objects.get(code="16")  # Alger
        algeria_ip = patch("core.views.is_algeria_ip", return_value=True)
        algeria_ip.start()
        self.addCleanup(algeria_ip.stop)

    def _post(self, **data):
        return self.client.post("/api/signalements/", data, format="multipart")

    def _create_ready(self, **overrides):
        data = dict(category="road", latitude=36.75, longitude=3.05, photos=[make_test_image()])
        data.update(overrides)
        resp = self._post(**data)
        self.assertEqual(resp.status_code, 201, resp.data)
        return Signalement.objects.get(pk=resp.data["id"])

    def test_create_with_gps_and_photo_is_pending_and_uses_nearest_wilaya(self):
        resp = self._post(category="electricity", latitude=36.75, longitude=3.05, description="Câble tombé", photos=[make_test_image()])
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertTrue(resp.data["access_token"])
        s = Signalement.objects.get(pk=resp.data["id"])
        self.assertEqual(s.processing_status, Signalement.PROCESSING_PENDING)
        self.assertEqual(s.wilaya, self.wilaya)
        self.assertEqual(s.photos.count(), 1)
        # Moderation is left to the worker: nothing is public yet.
        self.assertEqual(s.photos.get().moderation_status, Need.MODERATION_PENDING)
        self.assertIsNone(resp.data["photos"][0]["image"])

    def test_create_with_manual_address_only(self):
        resp = self._post(category="road", address="Rue Didouche Mourad", wilaya=self.wilaya.pk, photos=[make_test_image()])
        self.assertEqual(resp.status_code, 201, resp.data)
        s = Signalement.objects.get(pk=resp.data["id"])
        self.assertEqual(s.position_source, Signalement.POSITION_MANUAL)
        self.assertEqual(resp.data["display_latitude"], self.wilaya.centroid_latitude)

    def test_location_is_required(self):
        resp = self._post(category="road", photos=[make_test_image()])
        self.assertEqual(resp.status_code, 400)

    def test_manual_address_without_wilaya_is_rejected(self):
        resp = self._post(category="road", address="Rue X", photos=[make_test_image()])
        self.assertEqual(resp.status_code, 400)

    def test_photo_or_video_is_required(self):
        resp = self._post(category="road", latitude=36.75, longitude=3.05, description="Trou")
        self.assertEqual(resp.status_code, 400)
        audio = SimpleUploadedFile("voice.webm", b"fake-audio", content_type="audio/webm")
        resp = self._post(category="road", latitude=36.75, longitude=3.05, voice_file=audio)
        self.assertEqual(resp.status_code, 400)

    def test_gps_outside_algeria_is_rejected(self):
        resp = self._post(category="road", latitude=48.85, longitude=2.35, photos=[make_test_image()])
        self.assertEqual(resp.status_code, 400)

    def test_pending_report_is_hidden_until_processed(self):
        s = self._create_ready()
        self.assertEqual(self.client.get("/api/signalements/").data, [])
        with patch("core.signalements.moderate_image_field", return_value=Need.MODERATION_APPROVED):
            process_signalement(s.pk)
        listed = self.client.get("/api/signalements/").data
        self.assertEqual([x["id"] for x in listed], [s.pk])
        self.assertTrue(listed[0]["photos"][0]["image"])

    def test_rejected_media_keeps_report_hidden(self):
        s = self._create_ready()
        with patch("core.signalements.moderate_image_field", return_value=Need.MODERATION_REJECTED):
            process_signalement(s.pk)
        self.assertEqual(self.client.get("/api/signalements/").data, [])

    def test_list_filters_by_wilaya_and_category(self):
        oran = Wilaya.objects.get(code="31")
        a = self._create_ready(category="road")
        b = self._create_ready(category="waste", latitude=35.7, longitude=-0.63)
        with patch("core.signalements.moderate_image_field", return_value=Need.MODERATION_APPROVED):
            process_signalement(a.pk)
            process_signalement(b.pk)
        ids = lambda q: [x["id"] for x in self.client.get(f"/api/signalements/?{q}").data]  # noqa: E731
        self.assertEqual(ids(f"wilaya={oran.pk}"), [b.pk])
        self.assertEqual(ids("category=road"), [a.pk])

    def test_worker_transcribes_voice_and_video_and_moderates_video(self):
        audio = SimpleUploadedFile("voice.webm", b"fake-audio", content_type="audio/webm")
        video = SimpleUploadedFile("clip.webm", b"fake-video", content_type="video/webm")
        s = self._create_ready(photos=[], voice_file=audio, video_file=video)
        with patch("core.signalements.moderate_video_field", return_value=Need.MODERATION_APPROVED), patch(
            "core.signalements.transcribe_audio", side_effect=["Voix", VoiceAIError("No speech was detected.")]
        ):
            process_signalement(s.pk)
        s.refresh_from_db()
        self.assertEqual(s.processing_status, Signalement.PROCESSING_READY)
        self.assertEqual(s.video_moderation_status, Need.MODERATION_APPROVED)
        self.assertEqual(s.voice_transcript, "Voix")
        self.assertEqual(s.video_transcript, "")
        self.assertIn("No speech", s.processing_error)
        self.assertEqual(len(self.client.get("/api/signalements/").data), 1)

    def test_rejected_video_is_not_transcribed(self):
        video = SimpleUploadedFile("clip.webm", b"fake-video", content_type="video/webm")
        s = self._create_ready(photos=[], video_file=video)
        with patch("core.signalements.moderate_video_field", return_value=Need.MODERATION_REJECTED), patch(
            "core.signalements.transcribe_audio"
        ) as transcribe:
            process_signalement(s.pk)
        transcribe.assert_not_called()
        s.refresh_from_db()
        self.assertEqual(s.video_moderation_status, Need.MODERATION_REJECTED)

    def test_moderation_off_approves_media(self):
        config = AppConfiguration.get_solo()
        config.media_moderation_active = False
        config.save()
        s = self._create_ready()
        process_signalement(s.pk)
        self.assertEqual(s.photos.get().moderation_status, Need.MODERATION_APPROVED)


@override_settings(MEDIA_ROOT=MEDIA_ROOT)
class SignalementLot2Tests(BaseAPITestCase):
    def setUp(self):
        super().setUp()
        algeria_ip = patch("core.views.is_algeria_ip", return_value=True)
        algeria_ip.start()
        self.addCleanup(algeria_ip.stop)
        resp = self.client.post(
            "/api/signalements/",
            dict(category="electricity", latitude=36.75, longitude=3.05, photos=[make_test_image()]),
            format="multipart",
        )
        self.token = resp.data["access_token"]
        with patch("core.signalements.moderate_image_field", return_value=Need.MODERATION_APPROVED):
            self.s = process_signalement(resp.data["id"])

    def test_nearby_finds_open_reports_within_radius(self):
        near = self.client.get("/api/signalements/nearby/?lat=36.7503&lon=3.0502").data
        self.assertEqual([x["id"] for x in near], [self.s.pk])
        self.assertEqual(self.client.get("/api/signalements/nearby/?lat=36.76&lon=3.05").data, [])
        self.assertEqual(self.client.get("/api/signalements/nearby/?lat=36.75&lon=3.05&category=road").data, [])

    def test_confirm_counts_once_per_ip(self):
        url = f"/api/signalements/{self.s.pk}/confirm/"
        self.client.post(url)
        resp = self.client.post(url)
        self.assertEqual(resp.data["confirmations_count"], 1)

    def test_three_fixed_votes_resolve_the_report(self):
        url = f"/api/signalements/{self.s.pk}/report-fixed/"
        for i in range(3):
            resp = self.client.post(url, REMOTE_ADDR=f"10.0.0.{i + 1}")
        self.assertEqual(resp.data["status"], Signalement.STATUS_RESOLVED)
        self.assertEqual(self.client.get("/api/signalements/nearby/?lat=36.75&lon=3.05").data, [])

    def test_reporter_token_resolves_immediately(self):
        resp = self.client.post(f"/api/signalements/{self.s.pk}/report-fixed/", HTTP_X_ACCESS_TOKEN=self.token)
        self.assertEqual(resp.data["status"], Signalement.STATUS_RESOLVED)
        self.assertIsNotNone(resp.data["resolved_at"])

    def test_worker_classifies_other_category_with_llm(self):
        resp = self.client.post(
            "/api/signalements/",
            dict(category="other", latitude=36.75, longitude=3.05, description="Un grand trou sur la route", photos=[make_test_image()]),
            format="multipart",
        )
        with patch("core.signalements.moderate_image_field", return_value=Need.MODERATION_APPROVED), patch(
            "core.signalements.classify_category", return_value="road"
        ):
            s = process_signalement(resp.data["id"])
        self.assertEqual(s.category, "road")
        self.assertTrue(s.category_suggested_by_ai)


@override_settings(MEDIA_ROOT=MEDIA_ROOT)
class SignalementAccessAndManageTests(BaseAPITestCase):
    def _post(self, client=None, **data):
        payload = dict(category="road", latitude=36.75, longitude=3.05, photos=[make_test_image()])
        payload.update(data)
        return (client or self.client).post("/api/signalements/", payload, format="multipart")

    def test_non_algerian_ip_is_refused_even_with_geo_toggle_off(self):
        with patch("core.views.is_algeria_ip", return_value=False):
            self.assertEqual(self._post().status_code, 403)
            self.assertFalse(self.client.get("/api/config/").data["signali_available"])

    def test_admin_from_abroad_is_allowed_and_coordinates_outside_algeria_are_dropped(self):
        from django.contrib.auth.models import User

        User.objects.create_superuser("root", "r@x.dz", "pw")
        self.client.login(username="root", password="pw")
        with patch("core.views.is_algeria_ip", return_value=False):
            self.assertTrue(self.client.get("/api/config/").data["signali_available"])
            resp = self._post(latitude=48.85, longitude=2.35)
        self.assertEqual(resp.status_code, 201, resp.data)
        self.assertFalse(resp.data["has_exact_position"])
        self.assertEqual(resp.data["wilaya_name"], "Alger")

    def test_creator_ip_is_recorded(self):
        with patch("core.views.is_algeria_ip", return_value=True):
            resp = self._post(REMOTE_ADDR="41.100.0.5")
        self.assertIsNotNone(Signalement.objects.get(pk=resp.data["id"]).audit_creator_ip)

    def test_manage_with_code_changes_status_and_wrong_code_is_refused(self):
        with patch("core.views.is_algeria_ip", return_value=True):
            resp = self._post()
        url = f"/api/signalements/{resp.data['id']}/manage/"
        self.assertEqual(self.client.post(url, {"status": "cancelled"}, HTTP_X_ACCESS_TOKEN="nope").status_code, 403)
        ok = self.client.post(url, {"status": "in_review", "description": "Précision"}, format="json", HTTP_X_ACCESS_TOKEN=resp.data["access_token"])
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.data["status"], "in_review")
        self.assertEqual(ok.data["description"], "Précision")
        cancelled = self.client.post(url, {"status": "cancelled"}, format="json", HTTP_X_ACCESS_TOKEN=resp.data["access_token"])
        self.assertEqual(cancelled.data["status"], "cancelled")

    def test_cancelled_reports_leave_the_map_and_in_review_counts_as_open(self):
        with patch("core.views.is_algeria_ip", return_value=True):
            a = self._post().data
            b = self._post(latitude=35.7, longitude=-0.63).data
        with patch("core.signalements.moderate_image_field", return_value=Need.MODERATION_APPROVED):
            process_signalement(a["id"])
            process_signalement(b["id"])
        self.client.post(f"/api/signalements/{a['id']}/manage/", {"status": "in_review"}, format="json", HTTP_X_ACCESS_TOKEN=a["access_token"])
        self.client.post(f"/api/signalements/{b['id']}/manage/", {"status": "cancelled"}, format="json", HTTP_X_ACCESS_TOKEN=b["access_token"])
        self.assertEqual([x["id"] for x in self.client.get("/api/signalements/?status=open").data], [a["id"]])
        self.assertEqual([x["id"] for x in self.client.get("/api/signalements/").data], [a["id"]])

    def test_comments_on_a_report(self):
        with patch("core.views.is_algeria_ip", return_value=True):
            sid = self._post().data["id"]
        resp = self.client.post("/api/comments/", {"signalement": sid, "author_name": "Karim", "text": "Toujours là ce matin"}, format="json")
        self.assertEqual(resp.status_code, 201, resp.data)
        detail = self.client.get(f"/api/signalements/{sid}/").data
        self.assertEqual([c["text"] for c in detail["comments"]], ["Toujours là ce matin"])


@override_settings(MEDIA_ROOT=MEDIA_ROOT)
class SignalementAdminPendingTests(BaseAPITestCase):
    def test_admin_can_list_pending_reports_but_public_cannot(self):
        from django.contrib.auth.models import User

        with patch("core.views.is_algeria_ip", return_value=True):
            sid = self.client.post(
                "/api/signalements/",
                dict(category="road", latitude=36.75, longitude=3.05, photos=[make_test_image()]),
                format="multipart",
            ).data["id"]
        self.assertEqual(self.client.get("/api/signalements/?include_pending=1").data, [])
        User.objects.create_superuser("root", "r@x.dz", "pw")
        self.client.login(username="root", password="pw")
        listed = self.client.get("/api/signalements/?include_pending=1").data
        self.assertEqual([x["id"] for x in listed], [sid])
        self.assertEqual(listed[0]["processing_status"], "pending")
