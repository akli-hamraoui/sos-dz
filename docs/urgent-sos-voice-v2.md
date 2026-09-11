# SOSDZ — Urgent SOS Voice V2 implementation brief

## Goal
Finalize the discreet urgent voice SOS flow without changing the existing classic need flow.

## Non-negotiable behavior
- Route/page: rename the feature to `/urgent-sos` / `UrgentSOS` (keep a compatibility redirect from `/create-voice` if safe).
- Normal users: feature available only when the server confirms the request originates from Algeria.
- Admins: can use/test the feature from anywhere in the world.
- Server-side access control remains authoritative.
- No automatic voice confirmation. Final publication requires an explicit manual tap on a visible primary button.
- Future Yes/No voice confirmation is out of scope for this iteration, but component/state structure should allow it later.
- French UI/audio is the real implementation for now. Prepare the locale/audio lookup so Arabic can later replace `ar_*.mp3`; temporarily map Arabic audio to the French files.
- Never loop/repeat guide audio automatically. Audio is user-controlled: play/pause/replay, with visible text fallback.
- Mobile-first, responsive at small Android Chrome, tablet, laptop and desktop widths. No clipping, overlap, horizontal scroll or bottom-nav obstruction.

## Flow
1. Intro/instructions.
2. User-controlled guide audio + caption.
3. User starts microphone recording with an explicit tap.
4. Recording state: microphone active, timer, stop.
5. Preview: listen/re-record/continue.
6. Optional location capture by explicit user choice.
7. Transcription.
8. LLM extraction of as much information as actually present in the transcript as possible.
9. Review/edit summary.
10. Explicit [CONFIRM SOS] button.
11. Create a normal Need through the existing Need creation/data model/API path where possible.
12. Success screen and link to the created Need.

## LLM rules
Extract, when present:
- name
- phone
- need type
- urgency
- location / wilaya / commune / free-form location description
- quantity
- affected people
- organization/person
- useful additional details

Never invent facts. Missing values must use safe fallbacks such as:
- name: Anonyme
- phone: Non renseigné
- location: Sans localisation
- title: SOS urgent / existing localized fallback
- description: preserve the transcript/audio context rather than inventing details

An incomplete extraction must not prevent creation if the existing Need validation can accept the resulting media/content.

## Audio
- No autoplay loop.
- No timer-based replays.
- A guide step is advanced only by an explicit user action unless the product design deliberately makes a short informational step self-advancing.
- Microphone errors must be human-readable.
- Stop tracks on navigation/unmount.
- Handle denied permission, unavailable microphone, empty/too-long recording, unsupported MediaRecorder and network errors.

## Map/data integration
- The created record must be a normal Need, urgent/critical.
- Preserve the original voice file.
- Urgent voice SOS should be distinguishable as a red urgent SOS marker/bubble in the Algeria needs map/list, with access to the audio from the Need detail/list UI.
- Do not regress existing need/collection/pickup map popups, centering or mobile behavior.
- If a location is unavailable, use the existing Need no-location semantics instead of fabricating coordinates.

## i18n
Use the existing react-i18next setup and existing locale conventions. Add all new user-visible strings to fr/en/ar. Keep Arabic audio wired to the same French audio assets temporarily.

## Security
No LLM/API secret in frontend, localStorage, public files or URLs. Reuse existing backend secret/env architecture or add a backend environment variable if a provider integration is genuinely required.

## Regression protection
Do not rewrite CreateNeed.jsx or shared map components unless necessary. Before changing shared code, inspect all usages. Preserve routes, cards, bottom navigation, translations and existing APIs.

## Validation
Run available frontend build/lint and backend tests. Manually verify:
- /urgent-sos
- compatibility /create-voice if retained
- normal user outside Algeria blocked
- admin outside Algeria allowed
- French audio plays once on demand
- recording/preview/re-record
- transcription/LLM failure fallbacks
- manual confirmation only
- Need creation
- urgent red map marker/bubble
- mobile Android Chrome layout
- desktop layout
- existing classic Need creation and maps

Do not merge automatically. The PR must remain reviewable.
