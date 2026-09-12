"""Flyer photo -> structured collection-point data, via Gemini's free-tier
vision API (settings.GEMINI_API_KEY, see .env.example). This automates what
the project's maintainer used to do by hand: paste a flyer photo into a
chat LLM and get back a CSV row per collection point (see
management/commands/import_collection_points.py for the offline,
CSV-batch counterpart to this same idea). Structured JSON output
(Gemini's response_schema) is used instead of asking the model to "return
JSON" in prose, since the latter is far more prone to truncation/formatting
errors that would otherwise need fragile manual repair downstream.

Nothing here decides what gets published -- see core.views.FlyerSubmissionViewSet
and models.FlyerSubmission/ExtractedCollectionPoint: every result lands in
a human review queue (Django Admin) first, same as flyer_image moderation
does for the manual creation forms.
"""

import json
import logging
import time

from django.conf import settings

logger = logging.getLogger(__name__)

# Gemini's own "high demand" 503s (google.genai.errors.ServerError,
# confirmed live on the real deploy: "This model is currently experiencing
# high demand... Please try again later.") are transient -- worth a same-
# request retry rather than failing the submission outright and making the
# reporter re-upload the same photo by hand a few seconds later, which is
# all a retry on our end would have needed anyway.
EXTRACTION_MAX_ATTEMPTS = 3
EXTRACTION_RETRY_DELAY_SECONDS = 2


class ExtractionError(Exception):
    """The Gemini call failed, or returned something unusable."""


class ExtractionUnavailable(ExtractionError):
    """GEMINI_API_KEY isn't configured, or the feature is turned off
    (AppConfiguration.flyer_extraction_active) -- distinct from a genuine
    API failure so the caller can show a different, more actionable
    message ("this feature isn't set up" vs. "please try again later")."""


_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "country_found": {
            "type": "boolean",
            "description": "False only if NO point on the flyer has any identifiable country at all.",
        },
        "has_money_collection": {"type": "boolean"},
        "raw_text": {"type": "string"},
        "organization_common": {"type": "string"},
        "points": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "point_name": {"type": "string"},
                    "organization": {"type": "string"},
                    "country_code": {
                        "type": "string",
                        "description": "ISO 3166-1 alpha-2 code, e.g. 'DZ' for Algeria, 'FR' for France. Empty if the country can't be identified.",
                    },
                    "country_name": {"type": "string"},
                    "city": {"type": "string"},
                    "address": {"type": "string"},
                    "hours": {"type": "string"},
                    "accepted_donations": {"type": "string"},
                    "contact_name": {"type": "string"},
                    "contact_phone": {"type": "string"},
                    "other_phones": {"type": "string"},
                    "facebook_url": {"type": "string"},
                    "tiktok_url": {"type": "string"},
                    "instagram_url": {"type": "string"},
                },
                "required": ["country_code"],
            },
        },
    },
    "required": ["country_found", "has_money_collection", "points"],
}


PROMPT = """Tu es un assistant qui lit des flyers/affiches d'associations annonçant des points de collecte de dons humanitaires (Algérie et diaspora), postés sur les réseaux sociaux (Facebook/TikTok/Instagram).

Lis entièrement l'image fournie, quelle que soit la langue du texte (français, arabe, anglais, ou toute autre langue) : traduis en français les informations utiles pour les champs demandés, mais garde les noms propres — noms d'association, de lieux, de personnes — tels quels sans les traduire.

Règles impératives :

1. Un flyer peut annoncer PLUSIEURS points de collecte (ex : un tableau listant plusieurs villes/adresses). Crée une entrée dans "points" par point de collecte distinct.

2. N'invente JAMAIS une valeur. Si une information n'est pas clairement visible ou lisible sur l'image, laisse le champ correspondant vide (chaîne vide). Ne complète jamais un champ manquant par une supposition.

3. "country_code" (code pays ISO 3166-1 alpha-2, ex: "DZ" pour l'Algérie, "FR" pour la France) est le champ le plus important : renseigne-le pour chaque point si tu peux identifier le pays, même quand aucune autre information de localisation n'est disponible. Renseigne aussi "country_name" (nom du pays en français). "country_found" doit être false UNIQUEMENT si tu ne peux identifier le pays d'AUCUN point sur tout le flyer.

4. "address" : si tu identifies une adresse, complète-la pour qu'elle soit géolocalisable sur une carte (inclus la ville et le pays si le flyer ne donne qu'une adresse partielle, ex: nom d'un centre commercial ou d'un quartier). N'invente JAMAIS un numéro de rue précis qui n'apparaît pas sur le flyer — dans ce cas contente-toi de "nom du lieu, ville, pays".

5. Téléphones : identifie un numéro de contact principal ("contact_phone") et mets tous les autres numéros trouvés pour ce même point dans "other_phones" (séparés par des retours à la ligne).

6. "organization_common" : nom de l'association si un seul et même nom s'applique à TOUS les points du flyer. Renseigne aussi "organization" pour chaque point individuellement (même valeur si c'est la même association partout) — chaque point doit pouvoir être compris seul, indépendamment des autres.

7. "has_money_collection" (très important, exclusion stricte et totale) : mets true si le flyer mentionne, N'IMPORTE OÙ (y compris dans "raw_text"), un CCP, une cagnotte, Cotizup, un IBAN, PayPal, un RIP, un numéro de compte bancaire/postal, ou tout autre moyen de collecte d'ARGENT en ligne. Cette règle s'applique même si le reste des informations (adresse, contact) est par ailleurs valide et utile — signale-le quand même via ce champ, ne l'omets pas.

8. "raw_text" : recopie le texte brut intégral visible sur le flyer, traduit en français si le texte original est dans une autre langue (arabe, anglais, etc.), pour toute information non capturée dans les champs structurés ci-dessus.

Réponds uniquement avec les données structurées demandées, sans texte additionnel."""


def extract_flyer_data(image_bytes, mime_type="image/jpeg"):
    """Returns (data: dict, raw_response_text: str). Raises ExtractionError
    (or its ExtractionUnavailable subclass) on any failure -- the caller
    (FlyerSubmissionViewSet.create) is responsible for turning that into a
    FlyerSubmission.STATUS_FAILED rather than ever guessing at data."""
    if not settings.GEMINI_API_KEY:
        raise ExtractionUnavailable("GEMINI_API_KEY is not configured.")

    from core.models import AppConfiguration

    if not AppConfiguration.get_solo().flyer_extraction_active:
        raise ExtractionUnavailable("Flyer extraction is currently disabled (AppConfiguration).")

    try:
        from google import genai
        from google.genai import types
        from google.genai.errors import ServerError
    except ImportError as exc:
        raise ExtractionUnavailable("google-genai is not installed.") from exc

    client = genai.Client(api_key=settings.GEMINI_API_KEY)
    for attempt in range(1, EXTRACTION_MAX_ATTEMPTS + 1):
        try:
            response = client.models.generate_content(
                model=settings.GEMINI_MODEL,
                contents=[
                    types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                    PROMPT,
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=_RESPONSE_SCHEMA,
                    temperature=0.1,
                ),
            )
            break
        except ServerError as exc:
            logger.warning(
                "Gemini extraction attempt %s/%s failed (server error), %s",
                attempt, EXTRACTION_MAX_ATTEMPTS,
                "retrying" if attempt < EXTRACTION_MAX_ATTEMPTS else "giving up",
                exc_info=True,
            )
            if attempt == EXTRACTION_MAX_ATTEMPTS:
                raise ExtractionError(str(exc)) from exc
            time.sleep(EXTRACTION_RETRY_DELAY_SECONDS)
        except Exception as exc:
            # A 4xx (bad request, invalid key, quota exhausted) or any
            # other failure won't be fixed by retrying identically, unlike
            # ServerError above -- fail immediately, same as before.
            logger.warning("Gemini extraction call failed", exc_info=True)
            raise ExtractionError(str(exc)) from exc

    raw_response_text = response.text or ""
    try:
        data = json.loads(raw_response_text)
    except (ValueError, TypeError) as exc:
        raise ExtractionError(f"Gemini returned non-JSON output: {exc}") from exc

    if not isinstance(data.get("points"), list):
        raise ExtractionError("Gemini response is missing a 'points' array.")

    data.setdefault("country_found", bool(data["points"]))
    data.setdefault("has_money_collection", False)
    data.setdefault("raw_text", "")
    data.setdefault("organization_common", "")
    return data, raw_response_text
