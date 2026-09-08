// Shared helpers for the tap-driven, audio-narrated "SOS vocal guidé" flow
// (CreateNeedVoiceGuide.jsx) -- kept separate from that component so the
// audio-file convention and the auto-repeat timing constants live in one
// place, matching the "SOSDZ — Script d'enregistrements vocaux (v3)" spec.
//
// Audio files live at /public/audio/sos-guide/{lang}_{step}.mp3 (fr_0.mp3 ..
// fr_6.mp3, the real French recordings; ar_0.mp3 .. ar_6.mp3 are temporary
// copies of the fr_* files, per spec, until real Arabic recordings are
// provided -- swap them in place, same filenames, no code change needed).
// Every call here still fails silently on a missing/blocked file so the
// tap-driven flow keeps working even if a file is ever removed or an
// autoplay policy blocks it -- exactly per the spec's "tous les audios sont
// informatifs".
export const AUDIO_BASE = '/audio/sos-guide'

// Steps where the spec calls for auto-repeating the prompt if no tap is
// detected: language choice (0), geolocation yes/no (2), final validation
// (5). The purely informative steps (1, 3, 4, 6) are never repeated.
export function audioUrlFor(lang, step) {
  return `${AUDIO_BASE}/${lang}_${step}.mp3`
}

// Fire-and-forget playback -- swallows both a missing file (404) and a
// browser autoplay restriction (no prior user gesture on step 0's very
// first play) so a missing/blocked prompt never breaks navigation, which
// stays entirely tap-driven in this version regardless of audio outcome.
export function playGuideAudio(lang, step) {
  try {
    const audio = new Audio(audioUrlFor(lang, step))
    audio.play().catch(() => {})
    return audio
  } catch {
    return null
  }
}
