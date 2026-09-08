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


def transcribe_audio(upload, language=None):
    """Transcribe the recorded SOS with Groq Whisper, server-side.

    The UI language is intentionally not forced: Whisper auto-detects the
    language actually spoken in the recording.
    """
    content_type = upload.content_type or "audio/webm"
    model = getattr(settings, "GROQ_TRANSCRIPTION_MODEL", "whisper-large-v3-turbo")
    api_key = getattr(settings, "GROQ_API_KEY", "")
    if not api_key:
        logger.error(
            "Voice transcription unavailable: GROQ_API_KEY is missing; model=%s",
            model,
        )
        raise VoiceAIError("Voice transcription is not configured.")

    try:
        upload.seek(0)
        audio_bytes = upload.read()
    except (AttributeError, OSError) as exc:
        logger.exception("Could not read uploaded urgent SOS audio: %s", exc)
        raise VoiceAIError("Voice recording could not be read.")

    if not audio_bytes:
        logger.warning(
            "Voice transcription skipped: empty audio after reading upload; "
            "name=%s content_type=%s declared_size=%s",
            getattr(upload, "name", None),
            content_type,
            getattr(upload, "size", None),
        )
        raise VoiceAIError("No audio data was received.")

    try:
        response = requests.post(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (getattr(upload, "name", "urgent-sos.webm"), audio_bytes, content_type)},
            data={
                "model": model,
                "response_format": "json",
                "temperature": 0.0,
            },
            timeout=120,
        )
    except requests.RequestException as exc:
        logger.exception(
            "Voice transcription provider request failed: model=%s "
            "content_type=%s size=%s error=%s",
            model, content_type, len(audio_bytes), exc,
        )
        raise VoiceAIError("Voice transcription service is temporarily unavailable.")

    if not response.ok:
        logger.error(
            "Voice transcription provider rejected request: status=%s model=%s "
            "content_type=%s size=%s body=%s",
            response.status_code,
            model,
            content_type,
            len(audio_bytes),
            response.text[:2000],
        )
        raise VoiceAIError("Voice transcription failed.")

    try:
        payload = response.json()
    except ValueError:
        logger.error(
            "Voice transcription provider returned invalid JSON: status=%s model=%s body=%s",
            response.status_code, model, response.text[:2000],
        )
        raise VoiceAIError("Voice transcription returned invalid data.")

    text = (payload.get("text") or "").strip()
    if not text:
        logger.warning(
            "Voice transcription returned no text: model=%s content_type=%s "
            "size=%s response=%s",
            model, content_type, len(audio_bytes), payload,
        )
        raise VoiceAIError("No speech was detected.")

    logger.info(
        "Voice transcription succeeded: model=%s chars=%s content_type=%s size=%s transcript=%r",
        model, len(text), content_type, len(audio_bytes), text[:5000],
    )
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
