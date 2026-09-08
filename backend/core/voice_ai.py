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
    key = getattr(settings, "OPENAI_API_KEY", "")
    if not key:
        raise VoiceAIError("Voice analysis is not configured.")
    return {"Authorization": f"Bearer {key}"}


def transcribe_audio(upload, language="fr"):
    """Transcribe an uploaded webm/mp3/etc. server-side.

    The API key never reaches the browser. OpenAI's transcription endpoint
    accepts webm, which is the preferred MediaRecorder output on Android
    Chrome.
    """
    response = requests.post(
        "https://api.openai.com/v1/audio/transcriptions",
        headers=_headers(),
        files={"file": (upload.name, upload.file, upload.content_type or "audio/webm")},
        data={
            "model": getattr(settings, "OPENAI_TRANSCRIPTION_MODEL", "gpt-4o-mini-transcribe"),
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
    """Extract only facts explicitly present in the transcript.

    Empty strings are intentional: downstream code supplies safe emergency
    fallbacks rather than inventing information.
    """
    prompt = (
        "Extract emergency-need information from the following transcript. "
        "Use only information explicitly stated or unambiguously given. "
        "Never guess a name, phone, address, quantity, organization, or need. "
        "If a value is absent, return an empty string. Preserve useful wording "
        "in description. The output is for a user review screen before any "
        "publication. Transcript:\n\n" + transcript
    )
    payload = {
        "model": getattr(settings, "OPENAI_EXTRACTION_MODEL", "gpt-5.6-luna"),
        "input": prompt,
        "store": False,
        "text": {
            "format": {
                "type": "json_schema",
                "name": "urgent_sos_extraction",
                "strict": True,
                "schema": EXTRACTION_SCHEMA,
            }
        },
    }
    response = requests.post(
        "https://api.openai.com/v1/responses",
        headers={**_headers(), "Content-Type": "application/json"},
        json=payload,
        timeout=90,
    )
    if not response.ok:
        logger.warning("Voice extraction failed: status=%s body=%s", response.status_code, response.text[:500])
        raise VoiceAIError("Voice information extraction failed.")

    body = response.json()
    raw = body.get("output_text")
    if not raw:
        # Defensive fallback for response shapes that expose output content
        # without the SDK convenience property.
        chunks = []
        for item in body.get("output", []):
            for part in item.get("content", []):
                if part.get("type") in {"output_text", "text"} and part.get("text"):
                    chunks.append(part["text"])
        raw = "".join(chunks)
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        logger.warning("Voice extraction returned invalid JSON: %s", exc)
        raise VoiceAIError("Voice information extraction returned invalid data.")
    return {key: str(data.get(key) or "").strip() for key in EXTRACTION_SCHEMA["properties"]}
