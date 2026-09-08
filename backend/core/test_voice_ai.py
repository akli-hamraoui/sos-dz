from unittest.mock import Mock, patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, override_settings

from core.voice_ai import VoiceAIError, extract_need_data, transcribe_audio


class VoiceAIRequestTests(TestCase):
    @override_settings(GROQ_API_KEY="test-groq-key")
    def test_transcription_sends_valid_numeric_temperature_and_auto_detects_language(self):
        upload = SimpleUploadedFile(
            "urgent-sos.webm",
            b"fake-audio",
            content_type="audio/webm",
        )
        response = Mock()
        response.ok = True
        response.json.return_value = {"text": "Je suis à Blida et j'ai besoin d'eau."}

        with patch("core.voice_ai.requests.post", return_value=response) as post:
            result = transcribe_audio(upload, language="ar")

        self.assertEqual(result, "Je suis à Blida et j'ai besoin d'eau.")
        request = post.call_args.kwargs
        self.assertNotIn("language", request["data"])
        self.assertEqual(request["data"]["model"], "whisper-large-v3-turbo")
        self.assertEqual(request["data"]["temperature"], 0.0)
        self.assertIsInstance(request["data"]["temperature"], float)
        uploaded_name, uploaded_file, uploaded_type = request["files"]["file"]
        self.assertEqual(uploaded_name, "urgent-sos.webm")
        self.assertEqual(uploaded_type, "audio/webm")
        self.assertEqual(uploaded_file.read(), b"fake-audio")

    @override_settings(GROQ_API_KEY="test-groq-key")
    def test_transcription_converts_provider_error_to_voice_ai_error(self):
        upload = SimpleUploadedFile("urgent-sos.webm", b"fake-audio", content_type="audio/webm")
        response = Mock()
        response.ok = False
        response.status_code = 400
        response.text = '{"error":"invalid request"}'

        with patch("core.voice_ai.requests.post", return_value=response):
            with self.assertRaises(VoiceAIError):
                transcribe_audio(upload)

    @override_settings(GROQ_API_KEY="test-groq-key")
    def test_extraction_accepts_strict_json_schema_response(self):
        response = Mock()
        response.ok = True
        response.json.return_value = {
            "choices": [{
                "message": {
                    "content": (
                        '{"title":"Besoin d’eau","contact_name":"Ahmed",'
                        '"contact_phone":"0555000000","estimated_quantity":"",'
                        '"commune":"","location_description":"Blida",'
                        '"organization_or_person_name":"","description":"Besoin d’eau."}'
                    )
                }
            }]
        }

        with patch("core.voice_ai.requests.post", return_value=response) as post:
            result = extract_need_data("Je suis Ahmed à Blida, j'ai besoin d'eau.")

        self.assertEqual(result["contact_name"], "Ahmed")
        self.assertEqual(result["location_description"], "Blida")
        payload = post.call_args.kwargs["json"]
        self.assertEqual(payload["model"], "qwen/qwen3.8-27b")
        self.assertTrue(payload["response_format"]["json_schema"]["strict"])
