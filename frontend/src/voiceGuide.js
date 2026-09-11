// Shared helpers for the tap-driven, audio-narrated "SOS vocal guidé" flow.
// Audio files live at /public/audio/sos-guide/{lang}_{step}.mp3.
export const AUDIO_BASE = '/audio/sos-guide'
export const VOICE_GEO_RESTRICTED_AUDIO = `${AUDIO_BASE}/fr_9.mp3`
export const VOICE_GEO_RESTRICTED_AUDIO_AR = `${AUDIO_BASE}/ar_9.mp3`

export function audioUrlFor(lang, step) {
  return `${AUDIO_BASE}/${lang}_${step}.mp3`
}

export function playGuideAudio(lang, step) {
  try {
    const audio = new Audio(audioUrlFor(lang, step))
    audio.play().catch(() => {})
    return audio
  } catch {
    return null
  }
}

// Step 9 is the Algeria-only restriction message.
export function playVoiceGeoRestrictedAudio(lang = 'fr') {
  try {
    const audio = new Audio(audioUrlFor(lang === 'ar' ? 'ar' : 'fr', 9))
    audio.play().catch(() => {})
    return audio
  } catch {
    return null
  }
}
