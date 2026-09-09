import json
import logging
import os
from functools import lru_cache

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


@lru_cache(maxsize=1)
def _whisper_model():
    """Load one local Whisper model and reuse it for the process lifetime.

    The default is deliberately small enough for the 8 GB VPS. faster-whisper
    uses CTranslate2 int8 CPU inference, so no paid/cloud transcription API is
    required.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        logger.exception("Local Whisper dependency is missing")
        raise VoiceAIError("Voice transcription service is not installed.") from exc

    model_name = getattr(settings, "VOICE_WHISPER_MODEL", "small")
    device = getattr(settings, "VOICE_WHISPER_DEVICE", "cpu")
    compute_type = getattr(settings, "VOICE_WHISPER_COMPUTE_TYPE", "int8")
    logger.info(
        "Loading local Whisper model: model=%s device=%s compute_type=%s",
        model_name, device, compute_type,
    )
    try:
        return WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as exc:
        logger.exception("Could not load local Whisper model: model=%s", model_name)
        raise VoiceAIError("Voice transcription service is temporarily unavailable.") from exc


def transcribe_audio(upload, language=None):
    """Transcribe the SOS locally with faster-whisper.

    language is intentionally only a compatibility argument. Whisper auto
    detects the language actually spoken, which is important when an Algerian
    caller mixes French and Arabic in the same recording.
    """
    try:
        upload.seek(0)
        audio_bytes = upload.read()
    except (AttributeError, OSError) as exc:
        logger.exception("Could not read uploaded urgent SOS audio: %s", exc)
        raise VoiceAIError("Voice recording could not be read.") from exc

    if not audio_bytes:
        logger.warning(
            "Voice transcription skipped: empty audio; name=%s content_type=%s size=%s",
            getattr(upload, "name", None),
            getattr(upload, "content_type", None),
            getattr(upload, "size", None),
        )
        raise VoiceAIError("No audio data was received.")

    import tempfile
    suffix = os.path.splitext(getattr(upload, "name", "") or ".webm")[1] or ".webm"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp:
            temp.write(audio_bytes)
            temp_path = temp.name

        model = _whisper_model()
        segments, info = model.transcribe(
            temp_path,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=True,
        )
        text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    except VoiceAIError:
        raise
    except Exception as exc:
        logger.exception(
            "Local Whisper transcription failed: name=%s content_type=%s size=%s error=%s",
            getattr(upload, "name", None),
            getattr(upload, "content_type", None),
            len(audio_bytes),
            exc,
        )
        raise VoiceAIError("Voice transcription service is temporarily unavailable.") from exc
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                logger.warning("Could not remove temporary voice file: %s", temp_path)

    if not text:
        logger.warning("Local Whisper returned no speech: size=%s", len(audio_bytes))
        raise VoiceAIError("No speech was detected.")

    detected_language = getattr(info, "language", None)
    logger.info(
        "Voice transcription succeeded: provider=local-whisper model=%s detected_language=%s chars=%s transcript=%r",
        getattr(settings, "VOICE_WHISPER_MODEL", "small"),
        detected_language,
        len(text),
        text[:5000],
    )
    return text


def extract_need_data(transcript):
    """Extract only facts explicitly present in the transcript with local Qwen/Ollama."""
    ollama_url = getattr(settings, "VOICE_LLM_URL", "http://127.0.0.1:11434/api/chat")
    model = getattr(settings, "VOICE_LLM_MODEL", "qwen2.5:3b")
    prompt = (
        "You extract emergency SOS information from a French or Arabic transcript. "
        "Return ONLY JSON matching the supplied schema. Use only facts explicitly "
        "stated or unambiguously given. Never invent or guess a name, phone, address, "
        "quantity, organization, location or urgency. Missing values must be empty "
        "strings. Preserve the useful full transcript in description. "
        "This JSON is reviewed by a human before publication.\n\n"
        "TRANSCRIPT:\n" + transcript
    )
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "format": EXTRACTION_SCHEMA,
        "options": {"temperature": 0},
    }

    try:
        response = requests.post(ollama_url, json=payload, timeout=90)
    except requests.RequestException as exc:
        logger.exception("Local LLM request failed: url=%s model=%s error=%s", ollama_url, model, exc)
        raise VoiceAIError("Voice information extraction service is temporarily unavailable.") from exc

    if not response.ok:
        logger.error(
            "Local LLM rejected request: status=%s model=%s body=%s",
            response.status_code, model, response.text[:2000],
        )
        raise VoiceAIError("Voice information extraction failed.")

    try:
        body = response.json()
        raw = body.get("message", {}).get("content", "")
        data = json.loads(raw or "{}")
    except (ValueError, TypeError, json.JSONDecodeError, AttributeError) as exc:
        logger.exception("Local LLM returned invalid JSON: model=%s error=%s body=%s", model, exc, response.text[:2000])
        raise VoiceAIError("Voice information extraction returned invalid data.") from exc

    result = {key: str(data.get(key) or "").strip() for key in EXTRACTION_SCHEMA["properties"]}
    logger.info("Voice extraction succeeded: provider=ollama model=%s transcript_chars=%s extraction=%s", model, len(transcript), result)
    return result
