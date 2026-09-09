import json
import logging
import os
import tempfile
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


def _configure_whisper_cache():
    """Choose a cache writable by the Gunicorn service account.

    Production Gunicorn runs as www-data and its HOME may resolve to
    /var/www, which is not writable on this VPS. faster-whisper delegates
    model downloads to Hugging Face, so an unwritable HOME otherwise turns
    the first transcription request into a 503. Prefer the application
    cache when writable and fall back to /tmp when the deploy directory is
    root-owned.
    """
    candidates = [
        os.path.join(str(getattr(settings, "REPO_ROOT", "/opt/sos-dz")), ".cache", "huggingface"),
        os.path.join(tempfile.gettempdir(), "sos-dz-huggingface"),
    ]
    for cache_dir in candidates:
        try:
            os.makedirs(cache_dir, exist_ok=True)
            probe = os.path.join(cache_dir, ".write-test")
            with open(probe, "w", encoding="utf-8") as handle:
                handle.write("ok")
            os.unlink(probe)
            os.environ["HF_HOME"] = cache_dir
            os.environ["HF_HUB_CACHE"] = os.path.join(cache_dir, "hub")
            os.environ["HUGGINGFACE_HUB_CACHE"] = os.path.join(cache_dir, "hub")
            logger.info("Local Whisper cache configured: path=%s", cache_dir)
            return cache_dir
        except OSError as exc:
            logger.warning("Whisper cache unavailable: path=%s error=%s", cache_dir, exc)
    raise VoiceAIError("Voice transcription cache is not writable.")


@lru_cache(maxsize=1)
def _whisper_model():
    """Load one local Whisper model and reuse it for the process lifetime.

    The default is deliberately small enough for the 8 GB VPS. faster-whisper
    uses CTranslate2 int8 CPU inference, so no paid/cloud transcription API is
    required.
    """
    try:
        # Configure the cache BEFORE importing faster-whisper/huggingface_hub,
        # because those libraries read cache environment variables at import time.
        _configure_whisper_cache()
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


def process_voice_need(need_id):
    """Run Whisper + local LLM for an already-created guided voice Need.

    The Need/token are created before this function runs. A worker calls this
    function outside the HTTP request so slow local inference never blocks the
    reporter's token screen.
    """
    from core.models import Need

    need = Need.objects.get(pk=need_id)
    if need.voice_processing_status != Need.VOICE_PROCESSING_PENDING:
        return need

    try:
        if not need.voice_file:
            raise VoiceAIError("Voice recording is missing.")

        transcript = transcribe_audio(need.voice_file)
        extraction = extract_need_data(transcript)

        # The transcript is the source-of-truth description. LLM fields only
        # structure facts explicitly found in that transcript.
        for field in (
            "title",
            "contact_name",
            "contact_phone",
            "estimated_quantity",
            "commune",
            "location_description",
            "organization_or_person_name",
        ):
            value = (extraction.get(field) or "").strip()
            if value:
                setattr(need, field, value)

        need.description = transcript
        need.voice_processing_status = Need.VOICE_PROCESSING_READY
        need.voice_processing_error = ""
        need.record_edit()
        need.save()
        need.recompute_status()
        logger.info(
            "Guided voice SOS processed: need_id=%s transcript_chars=%s",
            need.pk, len(transcript),
        )
        return need
    except VoiceAIError as exc:
        need.voice_processing_status = Need.VOICE_PROCESSING_FAILED
        need.voice_processing_error = str(exc)[:500]
        need.save(update_fields=["voice_processing_status", "voice_processing_error", "last_modified_at"])
        logger.exception("Guided voice SOS processing failed: need_id=%s", need_id)
        return need
    except Exception as exc:
        need.voice_processing_status = Need.VOICE_PROCESSING_FAILED
        need.voice_processing_error = "Unexpected voice processing error."
        need.save(update_fields=["voice_processing_status", "voice_processing_error", "last_modified_at"])
        logger.exception("Unexpected guided voice SOS processing failure: need_id=%s error=%s", need_id, exc)
        return need
