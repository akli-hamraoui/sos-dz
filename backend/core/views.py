import logging
import secrets
import subprocess
from functools import lru_cache

from django.db.models import Prefetch, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView

from core.access import authorized_for_write, get_presented_token, is_admin_request, owner_authorized
from core.captcha import verify_turnstile
from core.duplicates import find_similar_collection_points, find_similar_needs
from core.gemini_extraction import (
    ExtractionError,
    ExtractionUnavailable,
    extract_flyer_data,
)
from core.collection_point_geocoding import (
    OFFLINE_CITY_COORDS,
    NominatimClient,
    contains_fundraising_keyword,
    split_phones,
)
from core.flyer_publish import publish_extracted_point
from core.geo import get_country_centroid
from core.geoip import is_algeria_ip
from core.media_validation import validate_photo_count, validate_photo_size
from core.moderation import moderate_image_field, moderate_video_field, moderation_active
from core.models import (
    AppConfiguration,
    AuditLog,
    Campaign,
    CollectionPoint,
    Comment,
    ContentReport,
    DamagePhoto,
    DeliveryPhoto,
    DisasterType,
    DuplicateReport,
    ExtractedCollectionPoint,
    FlyerSubmission,
    LocationPing,
    Need,
    Pickup,
    ProgressUpdate,
    SupportRequest,
    TranslationOverride,
    Wilaya,
)
from core.permissions import read_only_block, write_guard
from core.validators import is_within_algeria_bounds, normalize_place_name, validate_social_url
from core.serializers import (
    AnonymizeSerializer,
    AppConfigurationPublicSerializer,
    CampaignSerializer,
    CollectionPointCloseSerializer,
    CollectionPointCreateSerializer,
    CollectionPointMapPinSerializer,
    CollectionPointSerializer,
    CommentCreateSerializer,
    CommentSerializer,
    ContentReportSerializer,
    DisasterTypeSerializer,
    DuplicateReportCreateSerializer,
    FlyerSubmissionCreateSerializer,
    FlyerSubmissionStatusSerializer,
    IdentityRecoverySerializer,
    LocationPingSerializer,
    NeedCreateSerializer,
    NeedMapPinSerializer,
    NeedPublicSerializer,
    NeedUpdateGPSSerializer,
    PickupCreateSerializer,
    PickupListSerializer,
    PickupPublicSerializer,
    ProgressUpdateCreateSerializer,
    ProgressUpdateWithGPSSerializer,
    SupportRequestSerializer,
    WilayaSerializer,
)
from core.throttling import CreationRateThrottle
from core.voice_ai import VoiceAIError, extract_need_data, transcribe_audio

logger = logging.getLogger(__name__)


def log_admin_action(request, action_name, target):
    if is_admin_request(request):
        AuditLog.objects.create(admin_user=request.user, action=action_name, target_description=str(target))


class WilayaViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = Wilaya.objects.all()
    serializer_class = WilayaSerializer
    permission_classes = [AllowAny]
    pagination_class = None

    @action(detail=False, methods=["get"], url_path="nearest")
    def nearest(self, request):
        """Local reverse-geocoding convenience (Wave 3): suggests a wilaya
        from lat/long by nearest centroid -- the wilaya field itself stays
        the authoritative, user-confirmable value, this is just a prefill."""
        try:
            lat = float(request.query_params["lat"])
            lon = float(request.query_params["lon"])
        except (KeyError, ValueError):
            return Response({"detail": "lat and lon query params are required."}, status=status.HTTP_400_BAD_REQUEST)

        best, best_dist = None, None
        for wilaya in Wilaya.objects.exclude(centroid_latitude=None):
            dist = (wilaya.centroid_latitude - lat) ** 2 + (wilaya.centroid_longitude - lon) ** 2
            if best_dist is None or dist < best_dist:
                best, best_dist = wilaya, dist
        if best is None:
            return Response({"detail": "No wilaya reference data available."}, status=status.HTTP_404_NOT_FOUND)
        return Response(WilayaSerializer(best).data)


class DisasterTypeViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = DisasterType.objects.all()
    serializer_class = DisasterTypeSerializer
    permission_classes = [AllowAny]
    pagination_class = None


class CampaignViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    queryset = Campaign.objects.all().prefetch_related("authorized_wilayas")
    serializer_class = CampaignSerializer
    permission_classes = [AllowAny]
    pagination_class = None

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.query_params.get("active_only") == "1":
            qs = qs.filter(status=Campaign.STATUS_ACTIVE)
        return qs


@lru_cache(maxsize=1)
def _git_version():
    # Deploys here are a manual `git pull` + rebuild on the VPS (see
    # DEPLOYMENT.md step 6) with nothing else surfacing whether it actually
    # ran -- this lets a redeploy be confirmed by comparing this endpoint's
    # commit against `git log -1` on GitHub, instead of guessing from bug
    # reports whether a merged fix ever reached the live server. Cached for
    # the process lifetime since it can't change without a restart, which
    # is already how a redeploy takes effect here (systemctl restart).
    from django.conf import settings

    try:
        commit = (
            subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=settings.REPO_ROOT, stderr=subprocess.DEVNULL)
            .decode()
            .strip()
        )
        commit_date = (
            subprocess.check_output(
                ["git", "show", "-s", "--format=%cI", "HEAD"], cwd=settings.REPO_ROOT, stderr=subprocess.DEVNULL
            )
            .decode()
            .strip()
        )
    except (subprocess.CalledProcessError, FileNotFoundError, OSError):
        return {"commit": None, "commit_short": None, "commit_date": None}

    return {"commit": commit, "commit_short": commit[:7], "commit_date": commit_date}


class VersionView(APIView):
    """Public endpoint exposing the backend's currently running git commit
    -- see _git_version above for why this exists."""

    permission_classes = [AllowAny]

    def get(self, request):
        return Response(_git_version())


class AppConfigurationView(APIView):
    """Public subset of AppConfiguration -- read_only banner + moderation toggle."""

    permission_classes = [AllowAny]

    def get(self, request):
        from django.conf import settings

        data = AppConfigurationPublicSerializer(AppConfiguration.get_solo()).data
        data["turnstile_site_key"] = settings.TURNSTILE_SITE_KEY
        data["turnstile_enabled"] = settings.TURNSTILE_ENABLED
        # Lets the frontend show an "admin mode" badge and apply
        # admin-only conveniences (e.g. defaulting to Algiers instead of
        # erroring when a GPS position outside Algeria bounds would
        # otherwise be rejected) -- never a security boundary itself,
        # every actual write still re-checks is_admin_request server-side.
        data["is_admin"] = is_admin_request(request)
        # The guided voice SOS flow (CreateNeedVoiceGuide.jsx) isn't linked
        # from the site yet and, unlike the rest of the app, is meant to
        # always stay Algeria-only (or admin) regardless of the sitewide
        # geo_restrict_writes_to_algeria toggle above -- it's still pending
        # approval, reachable only via a direct link for testing. Re-checked
        # server-side on submission itself (NeedViewSet.create_via_voice_guide);
        # this copy is only so the page can show an explanatory message
        # instead of letting someone go through all 7 steps first.
        data["voice_guide_available"] = is_admin_request(request) or is_algeria_ip(getattr(request, "client_ip", None)) is True
        # Bottom-nav notification badges (frontend rounds/formats the
        # number) -- "active" on purpose, not a lifetime total: reflects
        # what there actually is to look at right now, not a count that
        # only ever grows.
        data["needs_open_count"] = Need.objects.filter(
            overall_status__in=[Need.STATUS_OPEN, Need.STATUS_PARTIALLY_COVERED],
            voice_processing_status=Need.VOICE_PROCESSING_READY,
        ).count()
        # country_code="" is the national/Algeria case (see
        # CollectionPoint.country_code) -- without this filter an
        # international point would inflate the *national* badge instead
        # of (or as well as) its own.
        data["collection_points_active_count"] = CollectionPoint.objects.filter(
            status=CollectionPoint.STATUS_ACTIVE, country_code=""
        ).count()
        data["international_collection_points_active_count"] = CollectionPoint.objects.filter(
            status=CollectionPoint.STATUS_ACTIVE
        ).exclude(country_code="").count()
        data["deliveries_en_route_count"] = Pickup.objects.filter(status=Pickup.STATUS_EN_ROUTE).count()
        return Response(data)


class TranslationOverridesView(APIView):
    """Public: admin-entered text corrections, one nested tree per locale
    (e.g. {"fr": {"home": {"tagline": "..."}}}) -- the frontend merges
    this over its static locale JSON bundles at startup so an admin can
    fix a piece of UI text without a deploy. A key with no override is
    simply absent here; the static bundle's value is used as-is."""

    permission_classes = [AllowAny]

    def get(self, request):
        result = {locale: {} for locale, _ in TranslationOverride.LOCALE_CHOICES}
        for override in TranslationOverride.objects.all():
            node = result.setdefault(override.locale, {})
            parts = override.key.split(".")
            for part in parts[:-1]:
                node = node.setdefault(part, {})
            node[parts[-1]] = override.value
        return Response(result)


class NeedViewSet(viewsets.GenericViewSet, mixins.ListModelMixin, mixins.RetrieveModelMixin):
    queryset = Need.objects.select_related("wilaya", "campaign", "disaster_type").prefetch_related(
        "pickups__progress_updates", "pickups__delivery_photos", "damage_photos", "comments__replies"
    )
    permission_classes = [AllowAny]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_serializer_class(self):
        if self.action in ("create", "create_via_voice_guide"):
            return NeedCreateSerializer
        return NeedPublicSerializer

    def get_throttles(self):
        if self.action in ("create", "create_via_voice_guide", "analyze_voice_guide"):
            return [CreationRateThrottle()]
        return []

    def get_queryset(self):
        qs = super().get_queryset()
        # A guided voice SOS still being transcribed has a valid token but
        # isn't ready for public discovery yet. One whose automatic
        # transcription failed (e.g. no speech detected, Whisper/Ollama
        # unavailable) stays published -- the reporter's audio and the
        # anonymous placeholders from creation are still there, so
        # responders can listen to it directly (see
        # core.voice_ai._mark_voice_need_failed) -- only PENDING is
        # filtered. Detail/recovery access remains available regardless;
        # only collection endpoints are filtered.
        if self.action in ("list", "locations"):
            qs = qs.exclude(voice_processing_status=Need.VOICE_PROCESSING_PENDING)
        wilaya = self.request.query_params.get("wilaya")
        campaign = self.request.query_params.get("campaign")
        search = self.request.query_params.get("search")
        no_location = self.request.query_params.get("no_location")
        if wilaya:
            qs = qs.filter(wilaya_id=wilaya)
        if campaign:
            qs = qs.filter(campaign_id=campaign)
        if no_location:
            # The map's "no location" bubble (NeedsList.jsx) groups every
            # such need behind one count regardless of its fallback
            # wilaya -- filtering by that wilaya would miss the ones that
            # fell back to a different one, so this is its own param.
            qs = qs.filter(has_no_location=True)
        if search:
            # As broad as the model reasonably allows -- a visitor searching
            # "Ahmed" or "0555..." should find a need by its contact just as
            # readily as by its title/location, same principle applied to
            # CollectionPointViewSet/PickupViewSet's own search below.
            qs = qs.filter(
                Q(title__icontains=search)
                | Q(location_description__icontains=search)
                | Q(commune__icontains=search)
                | Q(wilaya__name__icontains=search)
                | Q(organization_or_person_name__icontains=search)
                | Q(contact_name__icontains=search)
                | Q(contact_phone__icontains=search)
                | Q(other_phones__icontains=search)
                | Q(contact_email__icontains=search)
            )
        return qs

    def create(self, request, *args, **kwargs):
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        captcha_ok, captcha_error = verify_turnstile(request.data.get("turnstile_token"), getattr(request, "client_ip", None))
        if not captcha_ok:
            return Response({"detail": captcha_error}, status=status.HTTP_400_BAD_REQUEST)
        damage_photos = request.FILES.getlist("damage_photos")
        try:
            validate_photo_count(damage_photos)
            validate_photo_size(damage_photos)
        except Exception as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        need = serializer.save()

        if self.action == "create_via_voice_guide" and need.voice_file:
            # Return the token immediately. Whisper + LLM are handled by the
            # dedicated worker and the need stays hidden from public lists/map
            # until the complete transcript and structured extraction exist.
            need.voice_processing_status = Need.VOICE_PROCESSING_PENDING
            need.voice_processing_error = ""
            need.save(update_fields=["voice_processing_status", "voice_processing_error", "last_modified_at"])

        if need.video_file:
            need.video_moderation_status = moderate_video_field(need.video_file)
            need.video_moderated_by = Need.MODERATED_BY_SYSTEM if moderation_active() else ""
            need.save(update_fields=["video_moderation_status", "video_moderated_by"])
        # Voice has no visual content for NSFWJS to score; no moderation
        # field or step exists for it.

        for photo in damage_photos:
            dp = DamagePhoto(need=need, image=photo)
            dp.moderation_status = moderate_image_field(photo)
            dp.moderated_by = Need.MODERATED_BY_SYSTEM if moderation_active() else ""
            dp.save()

        out = NeedPublicSerializer(need).data
        out["access_token"] = need.access_token
        out["location_viewer_share_token"] = need.location_viewer_share_token
        out["duplicate_suggestions"] = NeedPublicSerializer(
            find_similar_needs(need.wilaya_id, f"{need.title} {need.location_description}", exclude_id=need.pk)[:3],
            many=True,
        ).data
        return Response(out, status=status.HTTP_201_CREATED)

    def _voice_feature_allowed(self, request):
        return is_admin_request(request) or is_algeria_ip(getattr(request, "client_ip", None)) is True

    @action(detail=False, methods=["post"], url_path="voice-guide/analyze")
    def analyze_voice_guide(self, request, *args, **kwargs):
        """Transcribe and extract a guided SOS without creating a Need.

        Publication remains a separate, explicit button action in the SPA.
        This endpoint is deliberately server-side so the LLM credential is
        never exposed to the browser.
        """
        if not self._voice_feature_allowed(request):
            return Response({"detail": "This feature is only available from Algeria."}, status=status.HTTP_403_FORBIDDEN)
        audio = request.FILES.get("audio")
        if not audio:
            return Response({"detail": "No audio file was provided."}, status=status.HTTP_400_BAD_REQUEST)
        if audio.size <= 0:
            return Response({"detail": "The audio file is empty."}, status=status.HTTP_400_BAD_REQUEST)
        if audio.size > 20 * 1024 * 1024:
            return Response({"detail": "The audio file is too large."}, status=status.HTTP_400_BAD_REQUEST)
        language = request.data.get("language", "fr")
        try:
            # Do not force the browser/UI language onto Whisper. The reporter
            # may speak a different language (or mix languages), so the STT
            # layer must auto-detect the actual recording language.
            transcript = transcribe_audio(audio)
            logger.info(
                "Urgent SOS transcription ready: language_hint=%s chars=%s transcript=%r",
                language, len(transcript), transcript[:5000],
            )
        except VoiceAIError as exc:
            logger.error(
                "Urgent SOS transcription unavailable: language_hint=%s "
                "audio_name=%s content_type=%s size=%s reason=%s",
                language,
                getattr(audio, "name", None),
                getattr(audio, "content_type", None),
                getattr(audio, "size", None),
                exc,
            )
            return Response({"detail": str(exc)}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        except Exception:
            logger.exception("Unexpected urgent SOS voice transcription error")
            return Response({"detail": "Voice transcription is temporarily unavailable."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)

        try:
            extraction = extract_need_data(transcript)
            logger.info(
                "Urgent SOS LLM extraction succeeded: fields=%s extraction=%s",
                sorted(extraction.keys()), extraction,
            )
        except VoiceAIError:
            # A good transcript is still valuable even if the structured LLM
            # extraction is unavailable. The frontend can show the transcript
            # and the user can correct the fields manually before confirming.
            logger.exception(
                "Urgent SOS transcript succeeded but LLM extraction failed; "
                "transcript=%r",
                transcript[:5000],
            )
            extraction = {}
        except Exception:
            logger.exception("Unexpected urgent SOS voice extraction error")
            extraction = {}

        return Response({"transcript": transcript, "extraction": extraction})

    @action(detail=False, methods=["post"], url_path="voice-guide")
    def create_via_voice_guide(self, request, *args, **kwargs):
        """CreateNeedVoiceGuide.jsx submits here instead of the regular
        create() above -- unlike an ordinary need report, this feature isn't
        linked from the site yet and is meant to stay Algeria-only (or
        admin) regardless of the sitewide geo_restrict_writes_to_algeria
        toggle (see write_guard, still applied below via create()), since
        it remains pending approval. AppConfigurationView exposes the same
        check as voice_guide_available so the page can show an explanatory
        message instead of letting someone go through all 7 steps first --
        that copy is UI-only, this is the actual enforcement."""
        if not self._voice_feature_allowed(request):
            return Response(
                {"detail": "This feature is only available from Algeria."},
                status=status.HTTP_403_FORBIDDEN,
            )
        # The regular Need serializer intentionally requires a recovery path.
        # A guided emergency may legitimately be anonymous, so give the
        # server-generated access-token path a private recovery code instead
        # of blocking publication when name/phone are both unknown.
        data = request.data.copy()
        if not ((data.get("contact_name") or "").strip() and (data.get("contact_phone") or "").strip()) and not (data.get("recovery_code") or "").strip():
            data["recovery_code"] = "voice-" + secrets.token_urlsafe(9)[:12]
        # Voice SOS is an admin-only exception to the normal Algeria write
        # restriction: keep the administrator's real GPS coordinates even
        # when they are outside Algeria. Do not silently convert a valid GPS
        # fix into "no location".
        request._full_data = data
        response = self.create(request, *args, **kwargs)
        # The guided SOS recovery code is the code the reporter can use later
        # to recover/delete the SOS. The regular Need response intentionally
        # does not expose recovery_code, so add it only to this dedicated
        # voice-SOS response where it is explicitly shown once on the final
        # screen.
        if response.status_code == status.HTTP_201_CREATED:
            response.data["recovery_code"] = data.get("recovery_code", "")
        return response

    @action(detail=False, methods=["get"], url_path="check-duplicates")
    def check_duplicates(self, request):
        """Non-blocking pre-submit suggestion: "a similar need already
        exists nearby, would you like to view it instead?" -- the frontend
        calls this before the user finishes publishing; it never blocks
        creation, per spec."""
        wilaya = request.query_params.get("wilaya")
        if not wilaya:
            return Response([])
        text = f"{request.query_params.get('title', '')} {request.query_params.get('description', '')}"
        matches = find_similar_needs(wilaya, text)
        return Response(NeedPublicSerializer(matches[:3], many=True).data)

    @action(detail=True, methods=["post"], url_path="report-duplicate")
    def report_duplicate(self, request, pk=None):
        need = self.get_object()
        reference = get_object_or_404(Need, pk=request.data.get("reference_need_id"))
        serializer = DuplicateReportCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        DuplicateReport.objects.create(reported_need=need, reference_need=reference, **serializer.validated_data)
        return Response(status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        need = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if need.is_anonymized:
            return Response({"detail": "This listing has been anonymized and is frozen from further edits."}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, need):
            return Response({"detail": "Not authorized: this access token doesn't match this need."}, status=status.HTTP_403_FORBIDDEN)

        data = request.data
        editable_fields = [
            "title", "estimated_quantity", "urgency", "commune", "location_description",
            "organization_or_person_name", "contact_email", "other_phones",
        ]
        changed = False
        for f in editable_fields:
            if f in data:
                setattr(need, f, data[f])
                changed = True

        if data.get("is_cancelled") is True and not need.is_cancelled:
            need.is_cancelled = True
            need.cancellation_reason = data.get("cancellation_reason", "")
            changed = True

        if changed:
            need.record_edit()
            need.save()
            need.recompute_status()
            log_admin_action(request, "edited need", need)

        return Response(NeedPublicSerializer(need).data)

    @action(detail=False, methods=["get"], url_path="locations")
    def locations(self, request):
        """Public: main map pins. Need locations only, never volunteer positions."""
        qs = self.get_queryset().exclude(is_cancelled=True)
        return Response(NeedMapPinSerializer(qs, many=True, context={"request": request}).data)

    @action(detail=True, methods=["get"], url_path="pickup-locations")
    def pickup_locations(self, request, pk=None):
        """Access-restricted: creator (token), share-link holder, or admin only."""
        need = self.get_object()
        viewer_token = request.query_params.get("viewer")
        allowed = (
            is_admin_request(request)
            or owner_authorized(request, need)
            or (viewer_token and not need.is_anonymized and viewer_token == need.location_viewer_share_token)
        )
        if not allowed:
            return Response(
                {"detail": "Not authorized to view this need's live location."},
                status=status.HTTP_403_FORBIDDEN,
            )
        active_pickups = need.pickups.exclude(status=Pickup.STATUS_CANCELLED)
        result = []
        for pickup in active_pickups:
            pings = list(pickup.location_pings.all())
            latest_update = pickup.progress_updates.order_by("-timestamp").first()
            result.append({
                "pickup": PickupPublicSerializer(pickup).data,
                "trail": LocationPingSerializer(pings, many=True).data,
                "latest_position": LocationPingSerializer(pings[-1]).data if pings else None,
                "latest_progress_text": latest_update.free_text if latest_update else None,
            })
        return Response(result)

    @action(detail=True, methods=["post"], url_path="regenerate-share-token")
    def regenerate_share_token(self, request, pk=None):
        need = self.get_object()
        if not (is_admin_request(request) or owner_authorized(request, need)):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)
        token = need.regenerate_share_token()
        log_admin_action(request, "regenerated share token", need)
        return Response({"location_viewer_share_token": token})

    @action(detail=True, methods=["post"], url_path="recover-access")
    def recover_access(self, request, pk=None):
        need = self.get_object()
        if need.is_anonymized:
            return Response({"detail": "This listing has been anonymized; access can no longer be recovered."}, status=status.HTTP_403_FORBIDDEN)
        serializer = IdentityRecoverySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        matched = need.matches_code(d.get("code")) if d.get("code") else need.matches_identity(d.get("name"), d.get("phone"))
        if not matched:
            return Response(
                {"detail": "No match. If this keeps happening, use the support/contact-admin form."},
                status=status.HTTP_403_FORBIDDEN,
            )
        token = need.regenerate_token()
        return Response({"access_token": token})

    @action(detail=True, methods=["post"], url_path="update-gps")
    def update_gps(self, request, pk=None):
        need = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if need.is_anonymized:
            return Response({"detail": "This listing has been anonymized and is frozen from further edits."}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, need):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)
        serializer = NeedUpdateGPSSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        need.latitude = serializer.validated_data["latitude"]
        need.longitude = serializer.validated_data["longitude"]
        need.position_accuracy = Need.POSITION_EXACT
        need.record_edit()
        need.save()
        return Response(NeedPublicSerializer(need).data)

    @action(detail=True, methods=["post"], url_path="anonymize")
    def anonymize(self, request, pk=None):
        need = self.get_object()
        if need.is_anonymized:
            return Response({"detail": "Already anonymized."})
        admin = is_admin_request(request)
        if not (admin or owner_authorized(request, need)):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)

        actor = need.OBFUSCATED_BY_ADMIN if admin else need.OBFUSCATED_BY_CREATOR
        is_active = need.overall_status in (Need.STATUS_OPEN, Need.STATUS_PARTIALLY_COVERED) and need.campaign.status != Campaign.STATUS_STOPPED
        if not admin and is_active:
            serializer = AnonymizeSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            if not serializer.validated_data["confirm"]:
                return Response(
                    {
                        "detail": "This listing is still active. Your contact details will be removed, "
                                  "others will no longer be able to reach you about this. Confirm to proceed.",
                        "requires_confirmation": True,
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
        need.anonymize(actor)
        AuditLog.objects.create(
            admin_user=request.user if admin else None,
            action="anonymized listing",
            target_description=f"Need #{need.pk}",
        )
        return Response(NeedPublicSerializer(need).data)


class PickupViewSet(viewsets.GenericViewSet, mixins.ListModelMixin, mixins.RetrieveModelMixin):
    queryset = Pickup.objects.select_related("need", "need__wilaya", "collection_point", "collection_point__wilaya").prefetch_related("progress_updates", "delivery_photos")
    permission_classes = [AllowAny]
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def get_serializer_class(self):
        if self.action == "create":
            return PickupCreateSerializer
        if self.action == "list":
            return PickupListSerializer
        return PickupPublicSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        wilaya = self.request.query_params.get("wilaya")
        status_param = self.request.query_params.get("status")
        search = self.request.query_params.get("search")
        # "need" / "collection_point" -- lets the Transporteurs page filter
        # down to only couriers headed to one destination type, on top of
        # the wilaya/status/search filters (all combinable, same AND-of-
        # filters pattern as the rest of this queryset).
        destination_type = self.request.query_params.get("destination_type")
        if wilaya:
            # Destination wilaya, not the courier's current position --
            # matches whichever of need/collection_point this pickup is
            # headed to (see Pickup.need/collection_point above: exactly
            # one is ever set).
            qs = qs.filter(Q(need__wilaya_id=wilaya) | Q(collection_point__wilaya_id=wilaya))
        if status_param:
            qs = qs.filter(status=status_param)
        if destination_type == "need":
            qs = qs.filter(need__isnull=False)
        elif destination_type == "collection_point":
            qs = qs.filter(collection_point__isnull=False)
        if search:
            # As broad as the model reasonably allows, matching against both
            # the courier's own info and their destination's (need or
            # collection point) -- see NeedViewSet's own search above.
            qs = qs.filter(
                Q(responder_name__icontains=search)
                | Q(responder_phone__icontains=search)
                | Q(responder_email__icontains=search)
                | Q(content_brought__icontains=search)
                | Q(organization_or_person_name__icontains=search)
                | Q(need__title__icontains=search)
                | Q(need__location_description__icontains=search)
                | Q(need__wilaya__name__icontains=search)
                | Q(need__contact_name__icontains=search)
                | Q(need__contact_phone__icontains=search)
                | Q(need__other_phones__icontains=search)
                | Q(collection_point__point_name__icontains=search)
                | Q(collection_point__organization__icontains=search)
                | Q(collection_point__location_description__icontains=search)
                | Q(collection_point__wilaya__name__icontains=search)
                | Q(collection_point__contact_name__icontains=search)
                | Q(collection_point__contact_phone__icontains=search)
                | Q(collection_point__other_phones__icontains=search)
            )
        return qs

    def get_throttles(self):
        if self.action == "create":
            return [CreationRateThrottle()]
        return []

    @action(detail=False, methods=["get"], url_path="live-locations")
    def live_locations(self, request):
        """Public aggregate map of every courier currently en route -- by
        product decision, unlike NeedViewSet.pickup_locations (which is
        access-restricted to that one need's owner/share-link/admin), this
        one is visible to anyone. Still respects the volunteer's own
        location_sharing_active consent toggle (never shows a *live* trail
        position for a pickup where that's off), and only ever exposes each
        pickup's latest known position, not its full trail.

        A courier who never turns on live sharing can still declare a
        rough departure point (Pickup.departure_latitude/longitude, set at
        take-charge time) -- that's shown here as a fallback, marked
        is_live=False, only for as long as there's no actual live ping to
        prefer instead. Once a live ping exists, it always wins."""
        pickups = (
            Pickup.objects.filter(status=Pickup.STATUS_EN_ROUTE)
            .filter(Q(location_sharing_active=True) | Q(departure_latitude__isnull=False))
            .select_related("need", "need__wilaya", "collection_point", "collection_point__wilaya")
            .prefetch_related(
                Prefetch("location_pings", queryset=LocationPing.objects.order_by("-recorded_at")),
                "delivery_photos",
            )
        )
        result = []
        for pickup in pickups:
            pings = list(pickup.location_pings.all()) if pickup.location_sharing_active else []
            if pings:
                latest = pings[0]
                latitude, longitude, recorded_at, is_live = latest.latitude, latest.longitude, latest.recorded_at, True
            elif pickup.departure_latitude is not None:
                latitude, longitude, recorded_at, is_live = pickup.departure_latitude, pickup.departure_longitude, None, False
            else:
                continue
            # Same "hidden until approved" gate as PickupListSerializer's
            # own photo field -- lets the map popup offer a "view photo"
            # shortcut without a second request.
            approved_photo = next((p for p in pickup.delivery_photos.all() if p.moderation_status == Need.MODERATION_APPROVED), None)
            entry = {
                "pickup_id": pickup.id,
                # Exactly one of these two pairs is populated, matching
                # whichever of need/collection_point this pickup belongs to
                # -- the frontend map picks whichever is present rather
                # than assuming need_id is always set.
                "need_id": pickup.need_id,
                "need_title": pickup.need.title if pickup.need_id else None,
                "need_wilaya_name": pickup.need.wilaya.name if pickup.need_id else None,
                "collection_point_id": pickup.collection_point_id,
                "collection_point_name": pickup.collection_point.point_name if pickup.collection_point_id else None,
                "collection_point_wilaya_name": pickup.collection_point.wilaya.name if pickup.collection_point_id else None,
                "responder_name": pickup.organization_or_person_name or pickup.responder_name,
                "content_brought": pickup.content_brought,
                "photo": (request.build_absolute_uri(approved_photo.image.url) if approved_photo else None),
                "latitude": latitude,
                "longitude": longitude,
                # Destination's own coordinates, when it has one set -- lets
                # the map draw a trajectory line from the courier's current
                # position to where they're headed. None (never a guessed
                # fallback) when the need/collection point has no exact GPS,
                # e.g. a need reported with only wilaya+description -- the
                # frontend simply skips the trajectory in that case.
                "destination_latitude": (pickup.need.latitude if pickup.need_id else pickup.collection_point.latitude),
                "destination_longitude": (pickup.need.longitude if pickup.need_id else pickup.collection_point.longitude),
                "recorded_at": recorded_at,
                "is_live": is_live,
                "departure_description": pickup.departure_description,
            }
            result.append(entry)
        return Response(result)

    def create(self, request, *args, **kwargs):
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        captcha_ok, captcha_error = verify_turnstile(request.data.get("turnstile_token"), getattr(request, "client_ip", None))
        if not captcha_ok:
            return Response({"detail": captcha_error}, status=status.HTTP_400_BAD_REQUEST)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        pickup = serializer.save()
        if pickup.need_id:
            pickup.need.recompute_status()
        out = PickupPublicSerializer(pickup).data
        out["access_token"] = pickup.access_token
        return Response(out, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        pickup = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if pickup.is_anonymized:
            return Response({"detail": "This listing has been anonymized and is frozen from further edits."}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, pickup):
            return Response({"detail": "Not authorized: this access token doesn't match this pickup."}, status=status.HTTP_403_FORBIDDEN)

        data = request.data
        if "content_brought" in data:
            pickup.content_brought = data["content_brought"]
        if "location_sharing_active" in data:
            pickup.location_sharing_active = bool(data["location_sharing_active"])
        if "departure_description" in data:
            pickup.departure_description = data["departure_description"] or ""
        # Lets a courier who skipped this at take-charge time add it later
        # (or edit/clear it), same optional text+map-pin shape and Algeria-
        # bounds validation as at creation (PickupCreateSerializer.validate).
        # Both keys present but null/blank clears the position; only one of
        # the two present is rejected the same way creation does.
        if "departure_latitude" in data or "departure_longitude" in data:
            lat, lon = data.get("departure_latitude"), data.get("departure_longitude")
            if lat in (None, "") and lon in (None, ""):
                pickup.departure_latitude = None
                pickup.departure_longitude = None
            elif lat in (None, "") or lon in (None, ""):
                return Response({"detail": "departure_latitude and departure_longitude must be provided together."}, status=status.HTTP_400_BAD_REQUEST)
            else:
                from core.validators import validate_algeria_bounds
                lat, lon = float(lat), float(lon)
                validate_algeria_bounds(lat, lon)
                pickup.departure_latitude = lat
                pickup.departure_longitude = lon
        if data.get("is_cancelled") is True and pickup.status != Pickup.STATUS_CANCELLED:
            pickup.status = Pickup.STATUS_CANCELLED
            pickup.cancellation_reason = data.get("cancellation_reason", "")
            # Same as mark_delivered(): a cancelled delivery must stop live
            # tracking immediately, not just once the courier happens to
            # untick the checkbox themselves.
            pickup.location_sharing_active = False
        pickup.save()
        if pickup.need_id:
            pickup.need.recompute_status()
        log_admin_action(request, "edited pickup", pickup)
        return Response(PickupPublicSerializer(pickup).data)

    @action(detail=True, methods=["post"], url_path="deliver")
    def deliver(self, request, pk=None):
        pickup = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, pickup):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)
        delivery_photos = request.FILES.getlist("delivery_photos")
        try:
            validate_photo_count(delivery_photos)
            validate_photo_size(delivery_photos)
        except Exception as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        for photo in delivery_photos:
            dp = DeliveryPhoto(pickup=pickup, image=photo)
            dp.moderation_status = moderate_image_field(photo)
            dp.moderated_by = Need.MODERATED_BY_SYSTEM if moderation_active() else ""
            dp.save()
        if delivery_photos and hasattr(pickup, "_prefetched_objects_cache"):
            pickup._prefetched_objects_cache.pop("delivery_photos", None)  # was cached empty by get_object()
        pickup.mark_delivered()
        return Response(PickupPublicSerializer(pickup).data)

    @action(detail=True, methods=["post"], url_path="progress-updates")
    def add_progress_update(self, request, pk=None):
        """Always public/free-text; never blocked by GPS or connectivity --
        GPS on a progress update is optional and purely additive."""
        pickup = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, pickup):
            return Response({"detail": "Not authorized: only the volunteer who owns this pickup can post updates."}, status=status.HTTP_403_FORBIDDEN)
        serializer = ProgressUpdateCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        update = ProgressUpdate.objects.create(pickup=pickup, **serializer.validated_data)
        return Response(ProgressUpdateWithGPSSerializer(update).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="location-pings")
    def add_location_ping(self, request, pk=None):
        pickup = self.get_object()
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if not authorized_for_write(request, pickup):
            return Response({"detail": "Not authorized: only this pickup's own volunteer can submit its position."}, status=status.HTTP_403_FORBIDDEN)
        # A finished delivery must never keep being geolocated -- reject any
        # ping submitted after the pickup left en_route (delivered or
        # cancelled), even if the frontend's own watchPosition somehow kept
        # running (a stale tab, a race on stop). Consent
        # (location_sharing_active) is granted by this same request when
        # it's currently off, same as before.
        if pickup.status != Pickup.STATUS_EN_ROUTE:
            return Response({"detail": "This delivery is no longer active; position updates are no longer accepted."}, status=status.HTTP_403_FORBIDDEN)
        serializer = LocationPingSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        from core.validators import validate_algeria_bounds
        validate_algeria_bounds(serializer.validated_data["latitude"], serializer.validated_data["longitude"])
        ping = LocationPing.objects.create(pickup=pickup, **serializer.validated_data)
        pickup.location_sharing_active = True
        pickup.save(update_fields=["location_sharing_active"])
        return Response(LocationPingSerializer(ping).data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=["post"], url_path="recover-access")
    def recover_access(self, request, pk=None):
        pickup = self.get_object()
        if pickup.is_anonymized:
            return Response({"detail": "This listing has been anonymized; access can no longer be recovered."}, status=status.HTTP_403_FORBIDDEN)
        serializer = IdentityRecoverySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        matched = pickup.matches_code(d.get("code")) if d.get("code") else pickup.matches_identity(d.get("name"), d.get("phone"))
        if not matched:
            return Response(
                {"detail": "No match. If this keeps happening, use the support/contact-admin form."},
                status=status.HTTP_403_FORBIDDEN,
            )
        token = pickup.regenerate_token()
        return Response({"access_token": token})

    @action(detail=True, methods=["post"], url_path="anonymize")
    def anonymize(self, request, pk=None):
        pickup = self.get_object()
        if pickup.is_anonymized:
            return Response({"detail": "Already anonymized."})
        admin = is_admin_request(request)
        if not (admin or owner_authorized(request, pickup)):
            return Response({"detail": "Not authorized."}, status=status.HTTP_403_FORBIDDEN)

        actor = pickup.OBFUSCATED_BY_ADMIN if admin else pickup.OBFUSCATED_BY_RESPONDER
        # A collection-point pickup has no campaign to check (CollectionPoint
        # isn't campaign-scoped) -- only the STATUS_STOPPED override applies
        # to a Need-linked pickup.
        campaign_stopped = pickup.need_id and pickup.need.campaign.status == Campaign.STATUS_STOPPED
        is_active = pickup.status == Pickup.STATUS_EN_ROUTE and not campaign_stopped
        if not admin and is_active:
            serializer = AnonymizeSerializer(data=request.data)
            serializer.is_valid(raise_exception=True)
            if not serializer.validated_data["confirm"]:
                return Response(
                    {
                        "detail": "This pickup is still active. Your contact details will be removed, "
                                  "others will no longer be able to reach you about this. Confirm to proceed.",
                        "requires_confirmation": True,
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
        pickup.anonymize(actor)
        AuditLog.objects.create(
            admin_user=request.user if admin else None,
            action="anonymized listing",
            target_description=f"Pickup #{pickup.pk}",
        )
        return Response(PickupPublicSerializer(pickup).data)


class SupportRequestViewSet(mixins.CreateModelMixin, viewsets.GenericViewSet):
    queryset = SupportRequest.objects.all()
    serializer_class = SupportRequestSerializer
    permission_classes = [AllowAny]


class ContentReportViewSet(mixins.CreateModelMixin, viewsets.GenericViewSet):
    """'Report this content' -- public, no auth beyond name+phone. Reporting
    immediately hides the content (sets its moderation_status back to
    pending, independent of the media_moderation_active toggle) and queues
    it for admin review."""

    queryset = ContentReport.objects.all()
    serializer_class = ContentReportSerializer
    permission_classes = [AllowAny]
    throttle_classes = [CreationRateThrottle]

    def create(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        report = serializer.save()
        media_obj = report.get_media_object()
        if media_obj is not None:
            if isinstance(media_obj, Need):
                field = "video_moderation_status"
            elif isinstance(media_obj, CollectionPoint):
                field = "flyer_moderation_status"
            else:
                field = "moderation_status"
            setattr(media_obj, field, Need.MODERATION_PENDING)
            media_obj.save(update_fields=[field])
        return Response(self.get_serializer(report).data, status=status.HTTP_201_CREATED)


COLLECTION_POINT_NOT_AUTHORIZED_MESSAGE = (
    "Not authorized: this access token doesn't match this collection point "
    "(or provide the matching name/phone/recovery code)."
)


def collection_point_identity_authorized(request, point):
    """Admin, a matching access_token, or (same fallback close() has always
    offered) the creator's own name+phone or recovery code -- shared so
    partial_update() below gives a creator who lost their access_token the
    same way back in that close() already does, rather than a stricter,
    token-only check for editing than for closing."""
    if is_admin_request(request) or owner_authorized(request, point):
        return True
    serializer = CollectionPointCloseSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    d = serializer.validated_data
    return point.matches_code(d.get("code")) if d.get("code") else point.matches_creator(d.get("contact_name"), d.get("contact_phone"))


class CollectionPointViewSet(viewsets.GenericViewSet, mixins.ListModelMixin, mixins.RetrieveModelMixin):
    queryset = CollectionPoint.objects.select_related("wilaya").prefetch_related(
        "comments__replies", "pickups__progress_updates", "pickups__delivery_photos"
    )
    permission_classes = [AllowAny]

    def get_serializer_class(self):
        if self.action == "create":
            return CollectionPointCreateSerializer
        return CollectionPointSerializer

    def get_throttles(self):
        return [CreationRateThrottle()] if self.action == "create" else []

    def get_queryset(self):
        qs = super().get_queryset()
        # Only the browsing endpoints (list/locations) split national vs.
        # international -- a direct retrieve-by-id (e.g. following a link
        # or a comment) always works regardless of which kind the point is,
        # since the caller doesn't necessarily know in advance.
        is_international_scope = False
        if self.action in ("list", "locations"):
            international = self.request.query_params.get("international")
            if international:
                is_international_scope = True
                qs = qs.exclude(country_code="")
                country = self.request.query_params.get("country")
                if country:
                    qs = qs.filter(country_code=country.upper())
            else:
                qs = qs.filter(country_code="")
        wilaya = self.request.query_params.get("wilaya")
        search = self.request.query_params.get("search")
        if wilaya:
            qs = qs.filter(wilaya_id=wilaya)
        if search:
            # As broad as the model reasonably allows, on both branches --
            # a visitor should be able to find a point by its phone number,
            # its accepted donations, or its own free-text description just
            # as readily as by name (see NeedViewSet's own search above).
            if is_international_scope:
                qs = qs.filter(
                    Q(point_name__icontains=search)
                    | Q(contact_name__icontains=search)
                    | Q(organization__icontains=search)
                    | Q(location_description__icontains=search)
                    | Q(description__icontains=search)
                    | Q(accepted_donations__icontains=search)
                    | Q(contact_phone__icontains=search)
                    | Q(other_phones__icontains=search)
                    | Q(country_name__icontains=search)
                )
            else:
                qs = qs.filter(
                    Q(point_name__icontains=search)
                    | Q(contact_name__icontains=search)
                    | Q(organization__icontains=search)
                    | Q(location_description__icontains=search)
                    | Q(description__icontains=search)
                    | Q(accepted_donations__icontains=search)
                    | Q(hours__icontains=search)
                    | Q(contact_phone__icontains=search)
                    | Q(other_phones__icontains=search)
                    | Q(wilaya__name__icontains=search)
                )
        return qs

    def create(self, request, *args, **kwargs):
        # An international collection point is deliberately created from
        # outside Algeria (that's the whole point) -- the Algeria-IP write
        # restriction would otherwise block almost every real submission.
        # Read-only mode still applies to everyone regardless.
        is_international = bool(request.data.get("country_code"))
        block_reason = read_only_block(request) if is_international else write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        flyer_image = request.FILES.get("flyer_image")
        if flyer_image:
            try:
                validate_photo_size([flyer_image])
            except Exception as exc:
                return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        point = serializer.save()
        # International always carries real GPS (validated above), so it's
        # always PRECISION_EXACT (the model default) -- only the national
        # branch needs setting explicitly here, matching what
        # has_exact_position already showed before precision_level existed
        # (real GPS vs. the wilaya-centroid fallback).
        if not is_international:
            point.precision_level = CollectionPoint.PRECISION_EXACT if point.latitude is not None else CollectionPoint.PRECISION_CITY
            point.save(update_fields=["precision_level"])

        if point.flyer_image:
            point.flyer_moderation_status = moderate_image_field(point.flyer_image)
            point.flyer_moderated_by = Need.MODERATED_BY_SYSTEM if moderation_active() else ""
            point.save(update_fields=["flyer_moderation_status", "flyer_moderated_by"])

        out = CollectionPointSerializer(point, context={"request": request}).data
        out["access_token"] = point.access_token
        return Response(out, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        point = self.get_object()
        # Same reasoning as create()/close() above: editing one's own
        # international point is expected to happen from outside Algeria too.
        block_reason = read_only_block(request) if point.is_international else write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if not collection_point_identity_authorized(request, point):
            return Response(
                {"detail": COLLECTION_POINT_NOT_AUTHORIZED_MESSAGE},
                status=status.HTTP_403_FORBIDDEN,
            )

        data = request.data
        # Deliberately excludes wilaya/country_code (would flip national vs.
        # international -- a different creation flow with its own
        # validation, not a simple field edit) and latitude/longitude/
        # flyer_image (re-validating a moved pin or re-moderating a new
        # flyer is more than this endpoint takes on for now) -- same
        # curated-allowlist approach as NeedViewSet.partial_update.
        editable_fields = [
            "point_name", "contact_name", "contact_phone", "other_phones",
            "organization", "location_description", "hours",
            "description", "accepted_donations",
        ]
        changed = False
        for f in editable_fields:
            if f in data:
                setattr(point, f, data[f])
                changed = True
        for f in ("facebook_url", "tiktok_url", "instagram_url"):
            if f in data:
                setattr(point, f, validate_social_url(data[f]))
                changed = True

        if changed:
            point.save()
            log_admin_action(request, "edited collection point", point)

        return Response(CollectionPointSerializer(point, context={"request": request}).data)

    @action(detail=False, methods=["get"], url_path="locations")
    def locations(self, request):
        """Public: pins for the SAME main map as Need pins (Wave 1) -- a
        visually distinct icon, same public/no-auth visibility as Needs."""
        qs = self.get_queryset().exclude(status=CollectionPoint.STATUS_CLOSED)
        return Response(CollectionPointMapPinSerializer(qs, many=True, context={"request": request}).data)

    @action(detail=True, methods=["post"], url_path="close")
    def close(self, request, pk=None):
        point = self.get_object()
        # Same reasoning as create() above: closing one's own international
        # point is expected to happen from outside Algeria too.
        block_reason = read_only_block(request) if point.is_international else write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        if not collection_point_identity_authorized(request, point):
            return Response({"detail": COLLECTION_POINT_NOT_AUTHORIZED_MESSAGE}, status=status.HTTP_403_FORBIDDEN)
        point.status = CollectionPoint.STATUS_CLOSED
        point.save(update_fields=["status"])
        log_admin_action(request, "closed collection point", point)
        return Response(CollectionPointSerializer(point, context={"request": request}).data)

    @action(detail=True, methods=["post"], url_path="recover-access")
    def recover_access(self, request, pk=None):
        point = self.get_object()
        serializer = IdentityRecoverySerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        d = serializer.validated_data
        matched = point.matches_code(d.get("code")) if d.get("code") else point.matches_creator(d.get("name"), d.get("phone"))
        if not matched:
            return Response(
                {"detail": "No match. If this keeps happening, use the support/contact-admin form."},
                status=status.HTTP_403_FORBIDDEN,
            )
        token = point.regenerate_token()
        return Response({"access_token": token})


def _safe_url(value):
    """Only keeps LLM-extracted social links that are actually well-formed
    http(s) URLs -- ExtractedCollectionPoint rows are created directly via
    .objects.create(), bypassing CollectionPointCreateSerializer's own
    validate_social_url, so nothing else would catch e.g. a bare "@handle"
    read straight off a flyer."""
    value = (value or "").strip()
    return value if value.startswith("http://") or value.startswith("https://") else ""


def _resolve_extracted_point_location(point_data, geocoder):
    """Turns one LLM-extracted point (country_code/city/address) into a
    dict describing where it actually goes: a matched Wilaya for Algeria,
    or country_code/country_name for anywhere else, plus best-effort
    coordinates and the precision they were found at. Mirrors the same
    address-then-city-then-nothing cascade as
    management/commands/import_collection_points.py's own resolve_national/
    resolve_international, except this pipeline is allowed to keep a
    point that only resolves to a city or a bare country -- that command
    rejects those outright since its target (CollectionPointCreateSerializer)
    requires exact GPS for international and a wilaya for national.
    Returns None if country_code is blank (caller decides what that means)."""
    country_code = (point_data.get("country_code") or "").strip().upper()
    country_name = (point_data.get("country_name") or "").strip()
    city = (point_data.get("city") or "").strip()
    address = (point_data.get("address") or "").strip()
    if not country_code:
        return None

    if country_code == "DZ":
        wilaya = None
        if city:
            normalized_city = normalize_place_name(city)
            for w in Wilaya.objects.all():
                if normalize_place_name(w.name) == normalized_city:
                    wilaya = w
                    break
        latitude = longitude = None
        precision_level = CollectionPoint.PRECISION_CITY if wilaya else CollectionPoint.PRECISION_COUNTRY
        # A real street address (longer/more specific than the bare city
        # name) is worth a live geocode for an exact pin; a bare city name
        # adds nothing over the wilaya's own centroid fallback.
        if address and len(address) > len(city) + 3:
            hit = geocoder.search(address, country_code="dz")
            if hit:
                latitude, longitude, _ = hit
                if is_within_algeria_bounds(latitude, longitude):
                    precision_level = CollectionPoint.PRECISION_EXACT
                else:
                    latitude = longitude = None
        return {
            "wilaya": wilaya, "country_code": "", "country_name": "", "city": city,
            "latitude": latitude, "longitude": longitude, "precision_level": precision_level,
        }

    # International.
    country_name = country_name or country_code
    latitude = longitude = None
    precision_level = CollectionPoint.PRECISION_COUNTRY
    if address and normalize_place_name(address) not in (normalize_place_name(city), normalize_place_name(country_name)):
        hit = geocoder.search(address, country_code=country_code)
        if hit:
            latitude, longitude, _ = hit
            precision_level = CollectionPoint.PRECISION_EXACT
    if precision_level == CollectionPoint.PRECISION_COUNTRY and city:
        hit = geocoder.search(f"{city}, {country_name}", country_code=country_code)
        if hit:
            latitude, longitude, _ = hit
            precision_level = CollectionPoint.PRECISION_CITY
        else:
            offline = OFFLINE_CITY_COORDS.get((normalize_place_name(city), country_code))
            if offline:
                latitude, longitude = offline
                precision_level = CollectionPoint.PRECISION_CITY
    return {
        "wilaya": None, "country_code": country_code, "country_name": country_name, "city": city,
        "latitude": latitude, "longitude": longitude, "precision_level": precision_level,
    }


class FlyerSubmissionViewSet(viewsets.GenericViewSet, mixins.RetrieveModelMixin):
    """The 'add a collection point from a flyer photo' pipeline: upload a
    photo, Gemini vision extracts one or more candidate points
    (core.gemini_extraction), and the result always lands in
    STATUS_NEEDS_REVIEW for a human to publish via Django Admin -- never
    published automatically, same principle as flyer_image moderation on
    the manual forms. See models.FlyerSubmission/ExtractedCollectionPoint,
    and the CSV-batch counterpart to this,
    management/commands/import_collection_points.py, for the offline
    version of the same idea."""

    queryset = FlyerSubmission.objects.prefetch_related("extracted_points__wilaya", "extracted_points__duplicate_of")
    permission_classes = [AllowAny]
    lookup_field = "access_token"

    def get_serializer_class(self):
        return FlyerSubmissionCreateSerializer if self.action == "create" else FlyerSubmissionStatusSerializer

    def get_throttles(self):
        return [CreationRateThrottle()] if self.action == "create" else []

    def create(self, request, *args, **kwargs):
        # A submission can turn out to be national or international only
        # AFTER extraction runs -- unlike CollectionPointViewSet.create,
        # which already knows from country_code in the request body. Uses
        # the more permissive read_only_block unconditionally (still blocks
        # everyone while the app is in read-only mode) rather than guessing.
        block_reason = read_only_block(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)

        flyer_image = request.FILES.get("flyer_image")
        if not flyer_image:
            return Response({"detail": "A flyer image is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            validate_photo_size([flyer_image])
        except Exception as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        submission = serializer.save()

        # Same fail-toward-review NSFW gate as the manual forms' flyer_image
        # -- but here it only blocks on a confirmed REJECTED; a still-
        # PENDING flyer (sidecar unreachable) proceeds to extraction below
        # same as an approved one, it just won't show the image publicly
        # until an admin clears it (see FlyerSubmissionAdmin).
        submission.flyer_moderation_status = moderate_image_field(submission.flyer_image)
        submission.flyer_moderated_by = Need.MODERATED_BY_SYSTEM if moderation_active() else ""
        submission.save(update_fields=["flyer_moderation_status", "flyer_moderated_by"])
        if submission.flyer_moderation_status == Need.MODERATION_REJECTED:
            submission.status = FlyerSubmission.STATUS_REJECTED
            submission.rejection_reason = FlyerSubmission.REJECTION_MODERATION
            submission.save(update_fields=["status", "rejection_reason"])
            return Response(FlyerSubmissionStatusSerializer(submission, context={"request": request}).data, status=status.HTTP_201_CREATED)

        try:
            submission.flyer_image.seek(0)
            image_bytes = submission.flyer_image.read()
            data, raw_response = extract_flyer_data(image_bytes, flyer_image.content_type or "image/jpeg")
        except ExtractionUnavailable as exc:
            # Unlike ExtractionError below, this is a misconfiguration
            # (missing GEMINI_API_KEY, flyer_extraction_active toggled off,
            # or google-genai not installed) rather than a transient API
            # failure -- every request fails identically until an admin
            # fixes it. Log the specific reason at error level so it shows
            # up next to the generic "Service Unavailable: /api/flyer-
            # submissions/" line the request logger already emits, instead
            # of that line being the only clue (see DEPLOYMENT.md's
            # GEMINI_API_KEY entry -- confirmed the hard way, this used to
            # be undiagnosable from server logs alone).
            logger.error("Flyer extraction unavailable for submission #%s: %s", submission.pk, exc)
            submission.status = FlyerSubmission.STATUS_FAILED
            submission.save(update_fields=["status"])
            return Response(
                {"detail": "This feature isn't available right now. Please try the manual form instead."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        except ExtractionError:
            logger.warning("Flyer extraction failed for submission #%s", submission.pk, exc_info=True)
            submission.status = FlyerSubmission.STATUS_FAILED
            submission.save(update_fields=["status"])
            return Response(FlyerSubmissionStatusSerializer(submission, context={"request": request}).data, status=status.HTTP_201_CREATED)

        submission.raw_extracted_text = data.get("raw_text", "")
        submission.llm_raw_response = raw_response
        submission.organization_common = data.get("organization_common", "")
        submission.save(update_fields=["raw_extracted_text", "llm_raw_response", "organization_common"])

        # Hard rejects, per spec -- neither is a "maybe": nothing published
        # and no candidate points created at all.
        point_texts = [str(p) for p in data.get("points", [])]
        if data.get("has_money_collection") or contains_fundraising_keyword(submission.raw_extracted_text, *point_texts):
            submission.status = FlyerSubmission.STATUS_REJECTED
            submission.rejection_reason = FlyerSubmission.REJECTION_MONEY_COLLECTION
            submission.save(update_fields=["status", "rejection_reason"])
            return Response(FlyerSubmissionStatusSerializer(submission, context={"request": request}).data, status=status.HTTP_201_CREATED)

        if not data.get("country_found") or not data.get("points"):
            submission.status = FlyerSubmission.STATUS_REJECTED
            submission.rejection_reason = FlyerSubmission.REJECTION_NO_COUNTRY
            submission.save(update_fields=["status", "rejection_reason"])
            return Response(FlyerSubmissionStatusSerializer(submission, context={"request": request}).data, status=status.HTTP_201_CREATED)

        geocoder = NominatimClient()
        for point_data in data["points"]:
            self._create_extracted_point(submission, point_data, geocoder)

        # Auto-publish as soon as extraction succeeds -- no admin review
        # queue in practice, so holding a valid point back until someone
        # looks at it would mean it never goes live at all. The one thing
        # still held back is a point that matches an existing, already-
        # published one closely enough to be flagged as a likely duplicate
        # (find_similar_collection_points): publishing that one too would
        # just put two near-identical pins on the map, so it's left
        # unpublished (still visible on this response, with a link to the
        # match) for an admin to promote later via publish_extracted_points
        # if the match turns out to be wrong.
        #
        # The check runs here, one point at a time in a stable order,
        # rather than at extraction time -- a flyer can list many points,
        # and find_similar_collection_points only ever looks at the live
        # CollectionPoint table. Running it here means each point's check
        # sees any earlier sibling from the *same* flyer that was just
        # published a moment ago in this same loop, so two points that
        # turn out to be the same place (e.g. repeated by mistake on the
        # flyer) don't both get published.
        published_any = False
        for child in submission.extracted_points.order_by("id"):
            city_or_wilaya = child.city or (child.wilaya.name if child.wilaya else "")
            duplicate = find_similar_collection_points(child.organization, city_or_wilaya, child.contact_phone)
            if duplicate:
                child.duplicate_of = duplicate
                child.save(update_fields=["duplicate_of"])
                continue
            publish_extracted_point(child)
            published_any = True

        if published_any:
            submission.status = FlyerSubmission.STATUS_PUBLISHED
            submission.reviewed_at = timezone.now()
            submission.save(update_fields=["status", "reviewed_at"])
        else:
            submission.status = FlyerSubmission.STATUS_REJECTED
            submission.rejection_reason = FlyerSubmission.REJECTION_DUPLICATE
            submission.save(update_fields=["status", "rejection_reason"])
        log_admin_action(request, "flyer auto-published" if published_any else "flyer rejected (duplicate)", submission)
        return Response(FlyerSubmissionStatusSerializer(submission, context={"request": request}).data, status=status.HTTP_201_CREATED)

    def _create_extracted_point(self, submission, point_data, geocoder):
        location = _resolve_extracted_point_location(point_data, geocoder) or {
            "wilaya": None, "country_code": "", "country_name": "", "city": "",
            "latitude": None, "longitude": None, "precision_level": CollectionPoint.PRECISION_COUNTRY,
        }
        organization = (point_data.get("organization") or "").strip() or submission.organization_common
        contact_phone, extra_phones = split_phones((point_data.get("contact_phone") or "").strip())
        other_phones_field = (point_data.get("other_phones") or "").strip()
        if other_phones_field:
            extra_phones = f"{extra_phones}\n{other_phones_field}".strip("\n") if extra_phones else other_phones_field

        city_or_wilaya = location["city"] or (location["wilaya"].name if location["wilaya"] else "")

        ExtractedCollectionPoint.objects.create(
            submission=submission,
            point_name=(point_data.get("point_name") or "").strip() or organization or city_or_wilaya or location["country_name"] or "Point de collecte",
            organization=organization,
            wilaya=location["wilaya"],
            country_code=location["country_code"],
            country_name=location["country_name"],
            city=location["city"],
            location_description=(point_data.get("address") or "").strip(),
            precision_level=location["precision_level"],
            latitude=location["latitude"],
            longitude=location["longitude"],
            hours=(point_data.get("hours") or "").strip(),
            accepted_donations=(point_data.get("accepted_donations") or "").strip(),
            contact_name=(point_data.get("contact_name") or "").strip(),
            contact_phone=contact_phone,
            other_phones=extra_phones,
            facebook_url=_safe_url(point_data.get("facebook_url")),
            tiktok_url=_safe_url(point_data.get("tiktok_url")),
            instagram_url=_safe_url(point_data.get("instagram_url")),
        )


class CommentViewSet(mixins.CreateModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):
    queryset = Comment.objects.all()
    permission_classes = [AllowAny]

    def get_serializer_class(self):
        return CommentCreateSerializer if self.action == "create" else CommentSerializer

    def get_throttles(self):
        return [CreationRateThrottle()] if self.action == "create" else []

    def create(self, request, *args, **kwargs):
        block_reason = write_guard(request)
        if block_reason:
            return Response({"detail": block_reason}, status=status.HTTP_403_FORBIDDEN)
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        comment = serializer.save()
        out = CommentSerializer(comment, context={"request": request}).data
        out["owner_token"] = comment.owner_token
        return Response(out, status=status.HTTP_201_CREATED)

    def destroy(self, request, *args, **kwargs):
        comment = self.get_object()
        if is_admin_request(request):
            log_admin_action(request, "deleted comment", comment)
            comment.delete()
            return Response(status=status.HTTP_204_NO_CONTENT)
        token = request.headers.get("X-Owner-Token") or request.data.get("owner_token")
        if not comment.matches_owner_token(token):
            return Response({"detail": "Not authorized to delete this comment."}, status=status.HTTP_403_FORBIDDEN)
        comment.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)

    @action(detail=True, methods=["post"], url_path="confirm")
    def confirm(self, request, pk=None):
        comment = self.get_object()
        comment.confirmation_count = comment.confirmation_count + 1
        comment.save(update_fields=["confirmation_count"])
        return Response(CommentSerializer(comment, context={"request": request}).data)
