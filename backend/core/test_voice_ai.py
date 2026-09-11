from unittest.mock import Mock, patch
import unittest
import os
import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from core.models import Need
from core.voice_ai import VoiceAIError, _configure_whisper_cache, extract_need_data, transcribe_audio


class _Segment:
    def __init__(self, text):
        self.text = text


class _Info:
    language = "fr"


class VoiceAIRequestTests(TestCase):
    @override_settings(VOICE_WHISPER_MODEL="small", VOICE_WHISPER_DEVICE="cpu", VOICE_WHISPER_COMPUTE_TYPE="int8")
    def test_transcription_uses_local_whisper_and_auto_detects_language(self):
        upload = SimpleUploadedFile("urgent-sos.webm", b"fake-audio", content_type="audio/webm")
        model = Mock()
        model.transcribe.return_value = (iter([_Segment("Je suis à Blida et j'ai besoin d'eau.")]), _Info())

        with patch("core.voice_ai._whisper_model", return_value=model):
            result = transcribe_audio(upload, language="ar")

        self.assertEqual(result, "Je suis à Blida et j'ai besoin d'eau.")
        args, kwargs = model.transcribe.call_args
        self.assertEqual(kwargs["beam_size"], 5)
        self.assertTrue(kwargs["vad_filter"])
        self.assertTrue(kwargs["condition_on_previous_text"])

    def test_whisper_cache_uses_writable_application_directory(self):
        with tempfile.TemporaryDirectory() as root:
            with override_settings(REPO_ROOT=root):
                cache_dir = _configure_whisper_cache()

            self.assertEqual(cache_dir, os.path.join(root, ".cache", "huggingface"))
            self.assertEqual(os.environ["HF_HOME"], cache_dir)
            self.assertEqual(os.environ["HF_HUB_CACHE"], os.path.join(cache_dir, "hub"))

    def test_transcription_converts_local_provider_error_to_voice_ai_error(self):
        upload = SimpleUploadedFile("urgent-sos.webm", b"fake-audio", content_type="audio/webm")
        model = Mock()
        model.transcribe.side_effect = RuntimeError("boom")

        with patch("core.voice_ai._whisper_model", return_value=model):
            with self.assertRaises(VoiceAIError):
                transcribe_audio(upload)

    @override_settings(VOICE_LLM_URL="http://127.0.0.1:11434/api/chat", VOICE_LLM_MODEL="qwen2.5:3b")
    def test_extraction_uses_local_qwen_and_strict_json_schema(self):
        response = Mock()
        response.ok = True
        response.json.return_value = {
            "message": {
                "content": (
                    '{"title":"Besoin d’eau","contact_name":"Ahmed",'
                    '"contact_phone":"0555000000","estimated_quantity":"",'
                    '"commune":"","location_description":"Blida",'
                    '"organization_or_person_name":"","description":"Besoin d’eau."}'
                )
            }
        }

        with patch("core.voice_ai.requests.post", return_value=response) as post:
            result = extract_need_data("Je suis Ahmed à Blida, j'ai besoin d'eau.")

        self.assertEqual(result["contact_name"], "Ahmed")
        self.assertEqual(result["location_description"], "Blida")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], "qwen2.5:3b")
        self.assertEqual(payload["stream"], False)
        self.assertEqual(payload["options"]["temperature"], 0)
        self.assertEqual(payload["format"]["type"], "object")
        self.assertEqual(payload["format"]["properties"]["contact_name"]["type"], "string")

    def test_extraction_provider_error_becomes_voice_ai_error(self):
        response = Mock()
        response.ok = False
        response.status_code = 503
        response.text = "Ollama unavailable"

        with patch("core.voice_ai.requests.post", return_value=response):
            with self.assertRaises(VoiceAIError):
                extract_need_data("Besoin urgent à Alger.")

    def test_arabic_transcript_is_sent_unchanged_to_local_llm(self):
        response = Mock()
        response.ok = True
        response.json.return_value = {"message": {"content": '{"title":"","contact_name":"","contact_phone":"","estimated_quantity":"","commune":"","location_description":"الجزائر","organization_or_person_name":"","description":"أحتاج إلى دواء."}'}}

        transcript = "أنا في الجزائر وأحتاج إلى دواء."
        with patch("core.voice_ai.requests.post", return_value=response) as post:
            result = extract_need_data(transcript)

        self.assertEqual(result["location_description"], "الجزائر")
        self.assertIn(transcript, post.call_args.kwargs["json"]["messages"][0]["content"])


class VoiceNeedProcessingTests(TestCase):
    def _create_need(self, recovery_code):
        from core.models import Campaign, DisasterType, Wilaya

        disaster = DisasterType.objects.create(name=f"Disaster {recovery_code}", icon="fire")
        campaign = Campaign.objects.create(
            campaign_name=f"Voice processing {recovery_code}",
            disaster_type=disaster,
            status=Campaign.STATUS_ACTIVE,
        )
        wilaya = Wilaya.objects.first()
        campaign.authorized_wilayas.add(wilaya)
        return Need.objects.create(
            campaign=campaign,
            title="SOS urgent",
            urgency=Need.URGENCY_CRITICAL,
            wilaya=wilaya,
            contact_name="Anonyme",
            recovery_code=recovery_code,
            voice_processing_status=Need.VOICE_PROCESSING_PENDING,
            voice_file=SimpleUploadedFile("urgent-sos.webm", b"fake-audio", content_type="audio/webm"),
        )

    def test_process_voice_need_saves_full_transcript_and_structured_fields(self):
        need = self._create_need("voice-test-1")
        transcript = "Je m'appelle Nadia, je suis à Béjaïa et nous avons besoin d'eau pour vingt familles."
        extraction = {
            "title": "Besoin d'eau",
            "contact_name": "Nadia",
            "contact_phone": "0555000000",
            "estimated_quantity": "vingt familles",
            "commune": "Béjaïa",
            "location_description": "Béjaïa",
            "organization_or_person_name": "",
            "description": "Résumé LLM qui ne doit pas remplacer la transcription.",
        }

        with patch("core.voice_ai.transcribe_audio", return_value=transcript), patch(
            "core.voice_ai.extract_need_data", return_value=extraction
        ):
            from core.voice_ai import process_voice_need
            process_voice_need(need.pk)

        need.refresh_from_db()
        self.assertEqual(need.description, transcript)
        self.assertEqual(need.contact_name, "Nadia")
        self.assertEqual(need.contact_phone, "0555000000")
        self.assertEqual(need.estimated_quantity, "vingt familles")
        self.assertEqual(need.location_description, "Béjaïa")
        self.assertEqual(need.voice_processing_status, Need.VOICE_PROCESSING_READY)
        self.assertEqual(need.voice_processing_error, "")

    def test_process_voice_need_marks_failed_when_transcription_fails(self):
        need = self._create_need("voice-test-2")

        with patch("core.voice_ai.transcribe_audio", side_effect=VoiceAIError("No speech was detected.")):
            from core.voice_ai import process_voice_need
            process_voice_need(need.pk)

        need.refresh_from_db()
        self.assertEqual(need.voice_processing_status, Need.VOICE_PROCESSING_FAILED)
        self.assertIn("No speech", need.voice_processing_error)
        # A failed transcription must never drop the SOS: the audio and the
        # anonymous contact placeholders set at creation stay, and a
        # fallback description is added so it isn't blank.
        self.assertEqual(need.contact_name, "Anonyme")
        self.assertTrue(need.voice_file)
        self.assertIn("audio", need.description.lower())

    def test_reconciles_fallback_wilaya_with_spoken_commune(self):
        """The wilaya set at creation was only ever an arbitrary fallback
        (no exact GPS) -- once the transcript names a real place, that
        should replace the guess rather than leaving a mismatched wilaya
        next to a correct location_description."""
        from core.models import Wilaya

        need = self._create_need("voice-test-4")
        fallback_wilaya = need.wilaya
        real_wilaya = Wilaya.objects.exclude(pk=fallback_wilaya.pk).get(name="Tizi Ouzou")
        need.campaign.authorized_wilayas.add(real_wilaya)
        transcript = "Je suis à Tizi Ouzou, j'ai besoin d'aide."
        extraction = {
            "title": "",
            "contact_name": "",
            "contact_phone": "",
            "estimated_quantity": "",
            "commune": "Tizi Ouzou",
            "location_description": "Tizi Ouzou, Algérie",
            "organization_or_person_name": "",
            "description": transcript,
        }

        with patch("core.voice_ai.transcribe_audio", return_value=transcript), patch(
            "core.voice_ai.extract_need_data", return_value=extraction
        ):
            from core.voice_ai import process_voice_need
            process_voice_need(need.pk)

        need.refresh_from_db()
        self.assertEqual(need.wilaya, real_wilaya)
        self.assertNotEqual(need.wilaya, fallback_wilaya)

    def test_reconciles_fallback_wilaya_from_location_description_when_commune_empty(self):
        """Confirmed live: for a very short recording the LLM sometimes
        puts the spoken place only in location_description ("Tizi Ouzou,
        Algérie") and leaves commune blank -- the wilaya must still be
        corrected, not just left on the arbitrary fallback next to a
        location_description that plainly names somewhere else."""
        from core.models import Wilaya

        need = self._create_need("voice-test-4b")
        fallback_wilaya = need.wilaya
        real_wilaya = Wilaya.objects.exclude(pk=fallback_wilaya.pk).get(name="Tizi Ouzou")
        need.campaign.authorized_wilayas.add(real_wilaya)
        transcript = "Tizi Ouzou"
        extraction = {
            "title": "",
            "contact_name": "",
            "contact_phone": "",
            "estimated_quantity": "",
            "commune": "",
            "location_description": "Tizi Ouzou, Algérie",
            "organization_or_person_name": "",
            "description": transcript,
        }

        with patch("core.voice_ai.transcribe_audio", return_value=transcript), patch(
            "core.voice_ai.extract_need_data", return_value=extraction
        ):
            from core.voice_ai import process_voice_need
            process_voice_need(need.pk)

        need.refresh_from_db()
        self.assertEqual(need.wilaya, real_wilaya)
        self.assertNotEqual(need.wilaya, fallback_wilaya)

    def test_does_not_override_wilaya_when_position_is_exact(self):
        """A real GPS fix (nearest-wilaya lookup) is a genuine signal --
        must never be second-guessed by a short/noisy transcript."""
        from core.models import Wilaya

        need = self._create_need("voice-test-5")
        need.position_accuracy = Need.POSITION_EXACT
        need.save(update_fields=["position_accuracy"])
        gps_wilaya = need.wilaya
        real_wilaya = Wilaya.objects.exclude(pk=gps_wilaya.pk).get(name="Tizi Ouzou")
        need.campaign.authorized_wilayas.add(real_wilaya)
        transcript = "Je suis à Tizi Ouzou, j'ai besoin d'aide."
        extraction = {
            "title": "", "contact_name": "", "contact_phone": "", "estimated_quantity": "",
            "commune": "Tizi Ouzou", "location_description": "Tizi Ouzou, Algérie",
            "organization_or_person_name": "", "description": transcript,
        }

        with patch("core.voice_ai.transcribe_audio", return_value=transcript), patch(
            "core.voice_ai.extract_need_data", return_value=extraction
        ):
            from core.voice_ai import process_voice_need
            process_voice_need(need.pk)

        need.refresh_from_db()
        self.assertEqual(need.wilaya, gps_wilaya)

    def test_failed_voice_need_still_appears_in_public_listing(self):
        need = self._create_need("voice-test-3")

        with patch("core.voice_ai.transcribe_audio", side_effect=VoiceAIError("No speech was detected.")):
            from core.voice_ai import process_voice_need
            process_voice_need(need.pk)

        response = APIClient().get("/api/needs/")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(any(row["id"] == need.pk for row in response.data["results"]))


class RealWhisperSmokeTest(TestCase):
    @unittest.skipUnless(
        os.getenv("VOICE_SMOKE_AUDIO"),
        "Set VOICE_SMOKE_AUDIO to a real browser-recorded audio file to run the local Whisper smoke test.",
    )
    def test_real_browser_audio_produces_transcription(self):
        path = os.environ["VOICE_SMOKE_AUDIO"]
        with open(path, "rb") as handle:
            upload = SimpleUploadedFile(
                os.path.basename(path),
                handle.read(),
                content_type="audio/webm",
            )
            transcript = transcribe_audio(upload)

        self.assertTrue(transcript.strip())
