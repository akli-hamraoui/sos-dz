from unittest.mock import Mock, patch
import os
import tempfile

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

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
