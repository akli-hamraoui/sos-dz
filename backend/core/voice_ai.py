import json
import logging

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

EXTRACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "contact_name": {"type": "string"},
        "contact_phone": {"type": "string"},
        "estimated_quantity": {"type": "string"},
        "commune": {"type": "string"},
        "location_description": {"type": "string"},
        "organization_or_person_name": {"type": "string"},
        "description": {"type": "string"},
    },
    "required": [
        "title", "contact_name", "contact_phone", "estimated_quantity",
        "commune", "location_description", "organization_or_person_name",
        "description",
    ],
    "additionalProperties": False,
}


class VoiceAIError(Exception):
    pass


def _headers():
    key = getattr(settings, "GROQ_API_KEY", "")
    if not key:
        raise VoiceAIError("Voice analysis is not configured.")
    return {"Authorization": f"Bearer {key}"}


def transcribe_audio(upload, language="fr"):
    """Transcribe the recorded SOS with Groq Whisper, server-side."""
    response = requests.post(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        headers=_headers(),
        files={"file": (upload.name, upload.file, upload.content_type or "audio/webm")},
        data={
            "model": getattr(settings, "GROQ_TRANSCRIPTION_MODEL", "whisper-large-v3-turbo"),
            "language": language if language in {"fr", "ar", "en"} else "fr",
            "response_format": "json",
            "temperature": "0",
        },
        timeout=120,
    )
    if not response.ok:
        logger.warning("Voice transcription failed: status=%s body=%s", response.status_code, response.text[:500])
        raise VoiceAIError("Voice transcription failed.")
    text = (response.json().get("text") or "").strip()
    if not text:
        raise VoiceAIError("No speech was detected.")
    return text


def extract_need_data(transcript):
    """Extract only facts explicitly present in the transcript."""
    prompt = (
        "Extract emergency-need information from this transcript. "
        "Use only facts explicitly stated or unambiguously given. "
        "Never guess a name, phone, address, quantity, organization, location, "
        "urgency detail, or need. If a value is absent, return an empty string. "
        "Preserve useful wording in description. The result is reviewed and "
        "edited by the user before publication. Respond only with the schema.\n\n"
        + transcript
    )
    payload = {
        "model": getattr(settings, "GROQ_EXTRACTION_MODEL", "qwen/qwen3.8-27b"),
        "messages": [
            {
                "role": "user",
                "content": prompt,
            }
        ],
        "temperature": 0,
        "reasoning_format": "hidden",
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "urgent_sos_extraction",
                "strict": True,
                "schema": EXTRACTION_SCHEMA,
            },
        },
    }
    response = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={**_headers(), "Content-Type": "application/json"},
        json=payload,
        timeout=90,
    )
    if not response.ok:
        logger.warning("Voice extraction failed: status=%s body=%s", response.status_code, response.text[:500])
        raise VoiceAIError("Voice information extraction failed.")

    body = response.json()
    try:
        raw = body["choices"][0]["message"]["content"]
        data = json.loads(raw or "{}")
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        logger.warning("Voice extraction returned invalid JSON: %s", exc)
        raise VoiceAIError("Voice information extraction returned invalid data.")
    return {key: str(data.get(key) or "").strip() for key in EXTRACTION_SCHEMA["properties"]}
