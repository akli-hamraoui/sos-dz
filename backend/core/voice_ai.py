import json
import logging
import os
import tempfile
from functools import lru_cache
from pathlib import Path

import requests
from django.conf import settings

from core.validators import normalize_place_name

logger = logging.getLogger(__name__)


def _match_wilaya_from_text(place_text, campaign):
    """Best-effort: does this free-text place name (the LLM-extracted
    'commune', or failing that 'location_description' -- the model isn't
    reliably consistent about which of the two it puts a spoken wilaya
    name into) name a wilaya authorized for this campaign? Used only to
    correct an administrative wilaya that was never a real signal in the
    first place (see process_voice_need) -- never touches a Need that
    already has an exact GPS fix."""
    guess = normalize_place_name(place_text)
    if not guess:
        return None
    for wilaya in campaign.authorized_wilayas.all():
        name = normalize_place_name(wilaya.name)
        if name and (name in guess or guess in name):
            return wilaya
    return None

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
    try:
        _configure_whisper_cache()
        from faster_whisper import WhisperModel
    except ImportError as exc:
        logger.exception("Local Whisper dependency is missing")
        raise VoiceAIError("Voice transcription service is not installed.") from exc
    model_name = getattr(settings, "VOICE_WHISPER_MODEL", "small")
    device = getattr(settings, "VOICE_WHISPER_DEVICE", "cpu")
    compute_type = getattr(settings, "VOICE_WHISPER_COMPUTE_TYPE", "int8")
    logger.info("Loading local Whisper model: model=%s device=%s compute_type=%s", model_name, device, compute_type)
    try:
        return WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as exc:
        logger.exception("Could not load local Whisper model: model=%s", model_name)
        raise VoiceAIError("Voice transcription service is temporarily unavailable.") from exc


def transcribe_audio(upload, language=None):
    try:
        upload.seek(0)
        audio_bytes = upload.read()
    except (AttributeError, OSError) as exc:
        logger.exception("Could not read uploaded urgent SOS audio: %s", exc)
        raise VoiceAIError("Voice recording could not be read.") from exc
    if not audio_bytes:
        logger.warning("Voice transcription skipped: empty audio; name=%s content_type=%s size=%s", getattr(upload, "name", None), getattr(upload, "content_type", None), getattr(upload, "size", None))
        raise VoiceAIError("No audio data was received.")
    suffix = os.path.splitext(getattr(upload, "name", "") or ".webm")[1] or ".webm"
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp:
            temp.write(audio_bytes)
            temp_path = temp.name
        model = _whisper_model()
        segments, info = model.transcribe(temp_path, beam_size=5, vad_filter=True, condition_on_previous_text=True)
        text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
    except VoiceAIError:
        raise
    except Exception as exc:
        logger.exception("Local Whisper transcription failed: name=%s content_type=%s size=%s error=%s", getattr(upload, "name", None), getattr(upload, "content_type", None), len(audio_bytes), exc)
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
    logger.info("Voice transcription succeeded: provider=local-whisper model=%s detected_language=%s chars=%s transcript=%r", getattr(settings, "VOICE_WHISPER_MODEL", "small"), detected_language, len(text), text[:5000])
    return text


# Official Arabic spelling of each of the 58 wilayas, keyed by the same
# fixed "code" used in seed_data.WILAYAS -- the Wilaya model only stores
# the French name, so a Whisper transcript in Arabic script has nothing
# to be corrected against without this.
ARABIC_WILAYA_NAMES = {
    "01": "أدرار", "02": "الشلف", "03": "الأغواط", "04": "أم البواقي",
    "05": "باتنة", "06": "بجاية", "07": "بسكرة", "08": "بشار",
    "09": "البليدة", "10": "البويرة", "11": "تمنراست", "12": "تبسة",
    "13": "تلمسان", "14": "تيارت", "15": "تيزي وزو", "16": "الجزائر",
    "17": "الجلفة", "18": "جيجل", "19": "سطيف", "20": "سعيدة",
    "21": "سكيكدة", "22": "سيدي بلعباس", "23": "عنابة", "24": "قالمة",
    "25": "قسنطينة", "26": "المدية", "27": "مستغانم", "28": "المسيلة",
    "29": "معسكر", "30": "ورقلة", "31": "وهران", "32": "البيض",
    "33": "إليزي", "34": "برج بوعريريج", "35": "بومرداس", "36": "الطارف",
    "37": "تندوف", "38": "تيسمسيلت", "39": "الوادي", "40": "خنشلة",
    "41": "سوق أهراس", "42": "تيبازة", "43": "ميلة", "44": "عين الدفلى",
    "45": "النعامة", "46": "عين تموشنت", "47": "غرداية", "48": "غليزان",
    "49": "تيميمون", "50": "برج باجي مختار", "51": "أولاد جلال",
    "52": "بني عباس", "53": "عين صالح", "54": "عين قزام", "55": "تقرت",
    "56": "جانت", "57": "المغير", "58": "المنيعة",
}


def _bilingual_wilaya_list():
    from core.models import Wilaya
    lines = []
    for code, name in Wilaya.objects.order_by("code").values_list("code", "name"):
        arabic = ARABIC_WILAYA_NAMES.get(code)
        lines.append(f"{name} ({arabic})" if arabic else name)
    return ", ".join(lines)


def _correction_prompt():
    path = Path(__file__).resolve().parent / "prompts" / "voice_transcription_correction.md"
    try:
        template = path.read_text(encoding="utf-8")
    except OSError:
        logger.exception("SOS transcription correction prompt could not be loaded: path=%s", path)
        return "Correct only obvious speech-to-text errors. Never invent information. GPS may only resolve an already spoken phonetic place/name; it must never create a location that was not spoken. If uncertain, preserve the original wording. Return only the corrected transcription."
    return template.replace("{{WILAYA_LIST}}", _bilingual_wilaya_list())


def correct_transcription(transcript, latitude=None, longitude=None):
    """Make one conservative correction pass before structured extraction."""
    if not transcript or not transcript.strip():
        return transcript
    ollama_url = getattr(settings, "VOICE_LLM_URL", "http://127.0.0.1:11434/api/chat")
    model = getattr(settings, "VOICE_LLM_MODEL", "qwen2.5:3b")
    system_prompt = _correction_prompt()
    gps_context = "GPS unavailable."
    if latitude is not None and longitude is not None:
        gps_context = f"GPS coordinates: latitude={latitude}, longitude={longitude}."
    prompt = system_prompt + "\n\nCONTEXT:\n" + gps_context + "\n\nORIGINAL WHISPER TRANSCRIPTION:\n" + transcript
    logger.info("SOS_VOICE_AI_TRACE INPUT transcript=%r gps=%s", transcript, gps_context)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "options": {"temperature": 0},
    }
    try:
        response = requests.post(ollama_url, json=payload, timeout=90)
    except requests.RequestException as exc:
        logger.warning("SOS transcription correction unavailable; keeping Whisper text: %s", exc)
        logger.info("SOS_VOICE_AI_TRACE CORRECTED transcript=%r fallback=true", transcript)
        return transcript
    if not response.ok:
        logger.warning("SOS transcription correction rejected: status=%s model=%s; keeping Whisper text", response.status_code, model)
        logger.info("SOS_VOICE_AI_TRACE CORRECTED transcript=%r fallback=true", transcript)
        return transcript
    try:
        corrected = str(response.json().get("message", {}).get("content", "")).strip()
    except (ValueError, TypeError, AttributeError):
        corrected = ""
    if not corrected or len(corrected) > max(len(transcript) * 3, 1000):
        logger.warning("SOS transcription correction produced unusable output; keeping Whisper text")
        logger.info("SOS_VOICE_AI_TRACE CORRECTED transcript=%r fallback=true", transcript)
        return transcript
    logger.info("SOS_VOICE_AI_TRACE CORRECTED transcript=%r fallback=false", corrected)
    return corrected


def extract_need_data(transcript):
    """Extract only facts explicitly present in the corrected transcript with local Qwen/Ollama."""
    ollama_url = getattr(settings, "VOICE_LLM_URL", "http://127.0.0.1:11434/api/chat")
    model = getattr(settings, "VOICE_LLM_MODEL", "qwen2.5:3b")
    prompt = (
        "You extract emergency SOS information from a French or Arabic transcript. "
        "Return ONLY JSON matching the supplied schema. Use only facts explicitly "
        "stated or unambiguously given. Never invent or guess a name, phone, address, "
        "quantity, organization, location or urgency. Missing values must be empty "
        "strings. Preserve the useful full transcript in description. This JSON is "
        "reviewed by a human before publication.\n\nTRANSCRIPT:\n" + transcript
    )
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}], "stream": False, "format": EXTRACTION_SCHEMA, "options": {"temperature": 0}}
    try:
        response = requests.post(ollama_url, json=payload, timeout=90)
    except requests.RequestException as exc:
        logger.exception("Local LLM request failed: url=%s model=%s error=%s", ollama_url, model, exc)
        raise VoiceAIError("Voice information extraction service is temporarily unavailable.") from exc
    if not response.ok:
        logger.error("Local LLM rejected request: status=%s model=%s body=%s", response.status_code, model, response.text[:2000])
        raise VoiceAIError("Voice information extraction failed.")
    try:
        body = response.json()
        raw = body.get("message", {}).get("content", "")
        data = json.loads(raw or "{}")
    except (ValueError, TypeError, json.JSONDecodeError, AttributeError) as exc:
        logger.exception("Local LLM returned invalid JSON: model=%s error=%s body=%s", model, exc, response.text[:2000])
        raise VoiceAIError("Voice information extraction returned invalid data.") from exc
    result = {key: str(data.get(key) or "").strip() for key in EXTRACTION_SCHEMA["properties"]}
    logger.info("SOS_VOICE_AI_TRACE JSON extraction=%s", json.dumps(result, ensure_ascii=False, sort_keys=True))
    logger.info("Voice extraction succeeded: provider=ollama model=%s transcript_chars=%s extraction=%s", model, len(transcript), result)
    return result


VOICE_TRANSCRIPTION_UNAVAILABLE_DESCRIPTION = (
    "Message vocal reçu mais non transcrit automatiquement. Écoutez "
    "l'enregistrement audio ci-dessous pour connaître la demande."
)


def process_voice_need(need_id):
    """Run Whisper + conservative correction + local LLM for an already-created guided voice Need."""
    from core.models import Need
    need = Need.objects.get(pk=need_id)
    if need.voice_processing_status != Need.VOICE_PROCESSING_PENDING:
        return need
    try:
        if not need.voice_file:
            raise VoiceAIError("Voice recording is missing.")
        transcript = transcribe_audio(need.voice_file)
        logger.info("VOICE_SOS_TRANSCRIPTION need_id=%s language=%s chars=%s transcript=%r", need.pk, getattr(need, "language", None), len(transcript or ""), transcript)
        if not transcript or not transcript.strip():
            raise VoiceAIError("Whisper returned an empty transcription.")
        corrected_transcript = correct_transcription(transcript, getattr(need, "latitude", None), getattr(need, "longitude", None))
        extraction = extract_need_data(corrected_transcript)
        for field in ("title", "contact_name", "contact_phone", "estimated_quantity", "commune", "location_description", "organization_or_person_name"):
            value = (extraction.get(field) or "").strip()
            if value:
                setattr(need, field, value)
        # The wilaya set at creation time is only ever a real signal when
        # the reporter had an exact GPS fix (nearest-wilaya lookup) --
        # otherwise it's an arbitrary fallback (see
        # NeedCreateSerializer.validate) that has nothing to do with what
        # was actually said. Once the transcript names a real place,
        # prefer that over the fallback guess.
        if need.position_accuracy != Need.POSITION_EXACT:
            matched_wilaya = None
            for candidate in (extraction.get("commune"), extraction.get("location_description")):
                candidate = (candidate or "").strip()
                if not candidate:
                    continue
                matched_wilaya = _match_wilaya_from_text(candidate, need.campaign)
                if matched_wilaya:
                    break
            if matched_wilaya and matched_wilaya.pk != need.wilaya_id:
                need.wilaya = matched_wilaya
                # has_no_location (set at creation when the reporter had
                # neither GPS nor a picked wilaya) means the map groups
                # this Need into the static "sans localisation" bubble
                # instead of its own animated pin (see NeedsList.jsx) --
                # correct once a real spoken place resolved a real wilaya,
                # since "no location" is no longer true.
                need.has_no_location = False
        need.description = corrected_transcript
        need.voice_processing_status = Need.VOICE_PROCESSING_READY
        need.voice_processing_error = ""
        need.record_edit()
        need.save()
        need.recompute_status()
        logger.info("SOS_VOICE_AI_TRACE NEED_READY need_id=%s json=%s", need.pk, json.dumps(extraction, ensure_ascii=False, sort_keys=True))
        logger.info("Guided voice SOS processed: need_id=%s transcript_chars=%s", need.pk, len(corrected_transcript))
        return need
    except VoiceAIError as exc:
        _mark_voice_need_failed(need, str(exc)[:500])
        logger.exception("Guided voice SOS processing failed: need_id=%s", need_id)
        return need
    except Exception as exc:
        _mark_voice_need_failed(need, "Unexpected voice processing error.")
        logger.exception("Unexpected guided voice SOS processing failure: need_id=%s error=%s", need_id, exc)
        return need


def _mark_voice_need_failed(need, error_message):
    """Automatic transcription/extraction failed (e.g. no speech detected,
    Whisper/Ollama unavailable). The reporter's audio and the anonymous
    contact placeholders set at creation time are still there -- a
    responder can listen to the recording directly, so this SOS must stay
    published rather than being silently dropped. Only the error itself is
    recorded (voice_processing_error, for admins) and a fallback
    description added when none exists yet; NeedViewSet.get_queryset only
    hides VOICE_PROCESSING_PENDING, not this status, so it's visible."""
    from core.models import Need

    need.voice_processing_status = Need.VOICE_PROCESSING_FAILED
    need.voice_processing_error = error_message
    if not need.description.strip():
        need.description = VOICE_TRANSCRIPTION_UNAVAILABLE_DESCRIPTION
    need.record_edit()
    need.save()
    need.recompute_status()
