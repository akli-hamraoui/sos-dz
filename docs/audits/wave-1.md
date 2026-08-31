# Wave 1 verification audit

Run against commit `edb11b0` (branch `claude/rassemble-disaster-relief-4xrkp1`). Verified via: `backend/core/tests.py` (46 automated tests, all passing), a real Chromium browser session (Playwright, vendored Leaflet/Alpine so it works without internet access to a CDN), and manual `curl` against a running dev server. Sections below only cover what Wave 1 actually specifies; Media/Security/Community/Finishing sections are marked N/A (not built yet).

## Data model completeness
- Fields for DisasterType, Campaign, Wilaya, Need, Pickup, ProgressUpdate, AppConfiguration, SupportRequest, AuditLog: **DONE**. Naming differences, all intentional: `Wilaya` gained `code` + `centroid_latitude/longitude` (needed for the map's centroid fallback, not in the original spec text but implied by the MAP VIEW section); `ProgressUpdate.gps_position` split into `gps_latitude`/`gps_longitude`; `SupportRequest.related_listing_id` implemented as `related_listing_description` (free text) rather than a generic FK, since the spec doesn't say which model it points to and a generic FK adds real complexity for a field that's just context for a human support agent.
- `Need`/`Pickup` already carry their Wave 2 media fields (`media_type`, `media_file`, `media_moderation_status`, `DamagePhoto`, `DeliveryPhoto`) and Wave 3's `media_moderation_status` values — built ahead of schedule while designing the schema, not filled in yet (no upload flow until Wave 2). **DONE DIFFERENTLY** (ahead of schedule, not a gap).
- Comment, CollectionPoint, DuplicateReport, ContentReport: **N/A**, Wave 3/4 scope.
- Multiple Pickups per Need enforced (FK, not 1:1): **DONE** — `test_multiple_pickups_in_parallel_allowed`.
- `overall_status` calculated, never settable via API: **DONE** — `test_overall_status_not_settable_directly`.
- Wilaya validated server-side against campaign's `authorized_wilayas`: **DONE** — `test_wilaya_must_be_in_campaign_authorized_list`, `test_wilaya_check_is_server_side_not_just_frontend`.

## Secrets hygiene
- Scanned README, `.env.example`, all committed config, and the full (short) git history for anything resembling a real credential: **DONE**, nothing found.
- README documents `python manage.py createsuperuser` with interactive credential entry, no generated/hardcoded password anywhere: **DONE**.
- `.env` gitignored and never committed at any point: **DONE** — confirmed via `git status`/`git log` at every commit so far.

## Authentication and permissions
- No SMS verification, no persistent citizen accounts: **DONE**.
- Access tokens generated on creation, stored client-side (localStorage), accepted for follow-up updates: **DONE** — verified via automated tests and the live browser session (progress update posted using the stored pickup token).
- Identity re-entry fallback works, issues new token, invalidates old: **DONE** — `test_identity_recovery_issues_new_token_and_invalidates_old`, `test_identity_recovery_wrong_identity_rejected`.
- Only creator (token/identity) can edit/cancel own listing, enforced server-side: **DONE** — `test_edit_requires_matching_token`, `test_non_admin_cannot_edit_without_token`.
- Admin override works on any Need/Pickup regardless of token, logged in AuditLog: **DONE** — `test_admin_can_edit_without_token`, `test_admin_override_is_logged`.
- Admin uses Django's built-in auth with a real password: **DONE**.

## Data anonymization (PII obfuscation)
- `pii_obfuscated_at` / `obfuscated_by` exist on Need and Pickup: **DONE**.
- Anonymizing replaces only identity fields, leaves title/description/media/wilaya/quantities/status/progress-update text untouched: **DONE** — `test_self_service_anonymize_requires_confirmation_when_active` asserts `need.title` is unchanged after anonymization.
- Masked everywhere including Django Admin: **DONE** — `test_anonymized_fields_hidden_everywhere_including_admin` fetches the rendered admin change page HTML and asserts the original name is absent.
- Admin can anonymize an individual listing anytime: **DONE** — `anonymize_selected` Django Admin action.
- Bulk anonymize at campaign closure is deliberate, not automatic: **DONE** — `anonymize_campaign_listings` is a separate, explicitly-triggered admin action; `test_admin_bulk_anonymize_at_campaign_closure_is_deliberate_not_automatic` confirms setting a campaign to "stopped" alone does not anonymize anything.
- Self-service: warning required while active, skipped once closed/cancelled: **DONE** — `test_self_service_anonymize_requires_confirmation_when_active`, `test_anonymize_no_warning_when_cancelled`.
- Access token stops granting identity-based edits after anonymization: **DONE** — `test_token_stops_working_after_anonymization`.

## Map view and location privacy
- LIST/MAP toggle, last view persisted locally: **DONE** — `localStorage` key `rassemble_view_mode`; confirmed present in code, not independently re-verified across a real page reload in the browser session (not high-risk, `localStorage.setItem`/`getItem` is a one-line mechanism).
- Main map exposes only Need pins, never volunteer positions: **DONE** — `test_main_map_never_exposes_pickup_positions` (API level) + code review of `renderMainMap()` (only calls `/needs/locations/`).
- Urgency-colored markers, centroid fallback labeled "no exact GPS position": **DONE** — verified in the live browser session (need without GPS showed "no exact GPS position" on its detail page; map popup code includes the same string for pins using the centroid fallback).
- Progress-update timeline public to everyone, unrestricted: **DONE** — `test_progress_update_timeline_always_public`; confirmed in template (the timeline block is not gated behind any ownership check).
- Embedded live map visible only to creator/share-link holder/admin, simply absent for anyone else (not a broken/empty map): **DONE** — `test_anonymous_visitor_cannot_see_pickup_locations`, `test_creator_can_see_pickup_locations`, `test_share_link_holder_can_see_pickup_locations`; frontend only renders the map section when `checkLiveMapAccess()` succeeds against the access-restricted endpoint.
- "Share live tracking" link + second person can view with no login: **DONE** — `test_share_link_holder_can_see_pickup_locations`; live-tested in browser (share button produces a `?viewer=` URL).
- Regenerating share token invalidates the old link: **DONE** — `test_regenerating_share_token_invalidates_old_link`.
- Access-restricted location endpoint returns clear 403, never a silent empty result: **DONE** — same test class, asserts `403` not `200` with `[]`.
- Live location sharing opt-in, never required: **DONE** by construction (`LocationPing` is entirely separate from `ProgressUpdate`; `location_sharing_active` defaults to `False`).
- Free-text progress update with no GPS/network succeeds: **DONE** — `test_progress_update_requires_no_gps_and_works_with_only_token` (submits with `gps_latitude`/`gps_longitude` omitted).
- Need pin popup: title, urgency, location text, description excerpt, coverage status, link to detail: **DONE** — implemented in `renderMainMap()`'s `bindPopup(...)` call; matches the field list. Not independently screenshotted (Leaflet tile images are blocked by this sandbox's network policy, but the popup DOM/content itself doesn't depend on tile loading and was checked by reading the code + confirming the map container itself renders, per the `06-after-pickup.png` screenshot).
- Pickup/volunteer marker popup: name, content brought, latest progress update: **DONE** — implemented in `renderDetailMap()`.
- Smart initial zoom + "no active needs" message only when truly zero listings exist: **DONE DIFFERENTLY IMPROVED THIS SESSION** — the "no active needs" message was initially only wired for the list view; added it for the map view too (see commit `edb11b0`). Zoom-out logic (`smartZoom`) was code-reviewed, not exercised with a real multi-wilaya dataset in the browser (would need several needs seeded across different regions to visually confirm the step-out behavior) — logic is straightforward (haversine distance + Leaflet `fitBounds`) but I'm not fully confident the exact zoom levels feel right without a human looking at it on real data. Flagging as **PARTIALLY VERIFIED**.
- Creator can add/update GPS after creation, pin moves to exact, existing pickups unaffected: **DONE** — `test_creator_can_add_gps_after_creation_pin_moves_to_exact`, `test_update_gps_does_not_affect_existing_pickups` (added this session, were missing before).

## Global controls
- `read_only` blocks creation of Needs, Pickups, ProgressUpdates at the API level: **DONE** — `test_read_only_blocks_creation`, `test_read_only_blocks_pickup_creation`, `test_read_only_blocks_progress_update_creation` (the latter two added this session; previously only Need creation was tested, a real gap that's now closed).
- Existing data remains fully viewable in read-only mode: **DONE** — `test_read_only_does_not_block_reading`.
- Default "Général" campaign with all 58 wilayas exists from first install: **DONE** — `test_default_campaign_covers_all_wilayas`, and confirmed via `manage.py migrate` on a fresh DB (data migration `0002_seed_data`).
- `media_moderation_active` toggle: **N/A** — field exists on `AppConfiguration` per the Wave 1 instruction to add it now, but nothing reads it yet (moderation itself is Wave 3).

## Anti-abuse
- Rate limiting 20/hour/IP with a clear error, not a silent drop: **DONE** — `test_rate_limit_returns_clear_error_not_silent_drop`.
- Captcha (Cloudflare Turnstile) on Need/Pickup creation: **DONE THIS SESSION** — was genuinely missing in the first checkpoint (settings existed but nothing enforced them); now implemented server-side (`core/captcha.py`, `verify_turnstile`, enforced in both create views) and client-side (widget rendered when enabled). **Caveat**: no real Cloudflare Turnstile site/secret key exists in this environment, so the actual Cloudflare verification round-trip has never run against the real API — only the "disabled" path (default, skip verification) and the "enabled but no/invalid token" rejection path are tested (`TurnstileCaptchaTests`). Whoever deploys this needs to obtain real Turnstile keys and confirm the live verification call once.
- Phone numbers masked by default with a reveal option: **DONE THIS SESSION for pickups** — the Need's own contact phone was already masked in the first checkpoint; pickup responder phone numbers were not masked at all (a real gap), fixed this session and confirmed in the live browser screenshot (`09-after-progress-update.png` shows "0666 XX XX 02" with a "show full number" link).
- Comment author phone never shown: **N/A**, Comment model is Wave 4.

## Geographic write restriction
- Write blocked from non-Algeria IP when enabled: **DONE** — `test_write_blocked_when_ip_not_algeria_and_restriction_enabled`.
- Same write succeeds as admin from a non-Algeria IP: **DONE** — `test_admin_bypasses_restriction_even_from_non_algeria_ip`.
- Read access always works regardless of location/toggle: **DONE** — `test_reading_always_works_regardless_of_restriction_or_location`.
- Toggle-off via Django Admin: **DONE** — plain editable `AppConfiguration` field, confirmed present in `AppConfigurationAdmin`.
- Distinct from the Wave 3 GPS-bounding-box check: **DONE** — both exist independently (`core/geoip.py` for IP, `core/validators.py` for coordinate content), each with a docstring cross-referencing the other so the distinction isn't lost later.
- **Caveat, same as the checkpoint**: no real MaxMind GeoLite2 database exists in this environment (requires a free account signup I can't do on the user's behalf). The IP-resolution code path itself (`core/geoip.py`) is only exercised in its "DB absent -> fail closed" branch by the tests; the actual MaxMind lookup logic has never run against a real `.mmdb` file. This is a real, currently-un-exercisable gap — flagging clearly rather than claiming full confidence.

## Media / Security / Community / Finishing sections
**N/A** — Waves 2-5 not yet built. Will be confirmed in their own audits and re-confirmed here doesn't apply since this file is scoped to Wave 1.

## Final honesty check
**Deviations from spec** (all listed above, repeated here for visibility): `Wilaya` carries extra `code`/centroid fields; `ProgressUpdate.gps_position` split into two float fields; `SupportRequest.related_listing_id` implemented as free text, not a FK; Need/Pickup already carry unused Wave 2/3 media fields.

**Skipped/deferred, now resolved this session**: Turnstile captcha was wired up (was missing), pickup responder phone masking was added (was missing), the map's "no active needs" message was extended to the map view (was list-only), 5 missing tests were added (update-gps × 3, read-only-blocks-pickup/progress-update × 2, Turnstile × 2).

**Still open / not fully confident**:
1. No live deployment exists (no IONOS/Railway credentials available in this environment) — `DEPLOYMENT.md` is written and accurate but untested against a real server.
2. GeoIP restriction's actual MaxMind lookup path has never run against a real `.mmdb` file (only the "database absent" fail-closed path is exercised).
3. Turnstile's actual Cloudflare verification call has never run against the real API (only the "disabled" and "enabled-but-rejected" paths are tested).
4. The map's smart zoom-out behavior (stepping out when no pins are nearby) is code-reviewed but not visually confirmed against a real multi-region dataset.
5. LIST/MAP view persistence across a real page reload was not independently re-verified in the browser session (low risk, one-line `localStorage` read/write).

Everything else in this checklist was actually exercised in this session — either by the automated test suite (46/46 passing) or by driving a real Chromium browser through the create → detail → take-charge → progress-update flow end to end, which surfaced and fixed one genuine bug (the "Also take charge" routing dead-end) that unit tests alone did not catch.
