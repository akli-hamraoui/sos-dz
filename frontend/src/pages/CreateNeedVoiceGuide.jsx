import { useState, useRef, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api, createOrQueue } from '../api'
import { translateApiError } from '../apiErrors'
import { IconMic, IconCheckCircle } from '../icons'
import { playGuideAudio, REPEATING_STEPS, REPEAT_DELAY_MS, MAX_REPEATS } from '../voiceGuide'

// Standalone, tap-driven, audio-narrated SOS flow -- "SOSDZ — Script
// d'enregistrements vocaux (v3)". Deliberately a brand-new page/route
// rather than a mode grafted onto CreateNeed.jsx: the two forms collect
// different things (this one takes name/phone/address/need as a single
// free-form voice recording, no typed fields at all) and are meant to stay
// independently reachable -- this file must never change CreateNeed.jsx's
// own behavior.
//
// Real French recordings (fr_0.mp3..fr_6.mp3) and their Arabic placeholder
// copies (ar_0.mp3..ar_6.mp3) both live under public/audio/sos-guide/ (see
// voiceGuide.js). Every step still advances correctly on tap alone even if
// a file is ever missing or blocked by an autoplay policy, exactly per spec
// ("tous les audios sont informatifs"). Visible captions mirror what each
// prompt says, both as a hearing-impaired-accessible fallback and so the
// flow stays fully testable without audio.
const STEP = { LANG: 0, INTRO: 1, GEO_ASK: 2, GEO_YES: 3, GEO_NO: 4, VALIDATE: 5, DONE: 6 }

export default function CreateNeedVoiceGuide() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { config, campaigns, saveNeedToken, refreshConfig } = useApp()
  const [step, setStep] = useState(STEP.LANG)
  const [lang, setLang] = useState('fr')
  // How many times the current step's prompt has already auto-repeated --
  // surfaced only for the max-reached case (buttons stay usable regardless,
  // per spec: no dead end, just no more nagging once the cap is hit).
  const [repeatsExhausted, setRepeatsExhausted] = useState(false)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [voiceBlob, setVoiceBlob] = useState(null)
  const [gps, setGps] = useState(null) // { latitude, longitude } | null
  const [wilayaId, setWilayaId] = useState(null)
  const [locating, setLocating] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [createdNeedId, setCreatedNeedId] = useState(null)

  const mediaRecorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)

  const activeCampaign = campaigns.find((c) => c.status === 'active')

  // Auto-repeat for the 3 steps that wait on a tap (language, geolocation
  // yes/no, final validation) -- replays the prompt every ~9s if the step
  // hasn't been left yet, up to MAX_REPEATS times, then stops on its own.
  // Advancing to a different step unmounts this effect (cleanup below),
  // which is what actually "cancels on tap" -- no explicit tap listener
  // needed here.
  useEffect(() => {
    if (!REPEATING_STEPS.includes(step)) return
    setRepeatsExhausted(false)
    let cancelled = false
    let timer
    let plays = 0
    const playOnce = () => {
      playGuideAudio(lang, step)
      plays += 1
      if (plays > MAX_REPEATS) {
        setRepeatsExhausted(true)
        return
      }
      timer = setTimeout(() => {
        if (!cancelled) playOnce()
      }, REPEAT_DELAY_MS)
    }
    playOnce()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [step, lang])

  // Purely informative steps (1, 6) play once; the geolocation-result steps
  // (3, 4) also play once but then auto-advance to validation on their own,
  // no tap needed -- primarily once the prompt actually finishes playing
  // ('ended'), with a generous fallback delay as a safety net for when the
  // audio file is missing/blocked (autoplay policy) and 'ended' never
  // fires. fr_3.mp3/fr_4.mp3 are short confirmations (~3-4s) -- the
  // fallback is set well past that so a slow connection loading the real
  // file doesn't get cut off before 'ended' has a chance to fire first.
  useEffect(() => {
    if (![STEP.INTRO, STEP.GEO_YES, STEP.GEO_NO, STEP.DONE].includes(step)) return
    const audio = playGuideAudio(lang, step)
    if (step !== STEP.GEO_YES && step !== STEP.GEO_NO) return undefined
    let advanced = false
    const advance = () => {
      if (advanced) return
      advanced = true
      setStep(STEP.VALIDATE)
    }
    const fallback = setTimeout(advance, 8000)
    audio?.addEventListener('ended', () => {
      clearTimeout(fallback)
      advance()
    })
    return () => clearTimeout(fallback)
  }, [step, lang])

  // Cleanup on unmount -- stops a still-running recorder/mic rather than
  // leaking the stream if the visitor navigates away mid-recording.
  useEffect(
    () => () => {
      clearInterval(timerRef.current)
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop()
    },
    []
  )

  const chooseLang = (code) => {
    setLang(code)
    setStep(STEP.INTRO)
  }

  const startRecording = async () => {
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError(t('createNeed.gpsError')) // mic permission denied/unavailable -- reuse the closest existing generic device-access error copy
      return
    }
    const mediaRecorder = new MediaRecorder(stream)
    chunksRef.current = []
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop())
      const blob = new Blob(chunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' })
      setVoiceBlob(blob)
      setStep(STEP.GEO_ASK)
    }
    mediaRecorderRef.current = mediaRecorder
    setSeconds(0)
    setRecording(true)
    mediaRecorder.start()
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000)
  }

  const finishRecording = () => {
    clearInterval(timerRef.current)
    setRecording(false)
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop()
  }

  const acceptGeo = () => {
    if (!navigator.geolocation) {
      setStep(STEP.GEO_NO)
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords
        setGps({ latitude, longitude })
        try {
          const suggestion = await api(`/wilayas/nearest/?lat=${latitude}&lon=${longitude}`)
          setWilayaId(suggestion.id)
        } catch {
          /* best-effort only -- submission below still proceeds without a wilaya */
        }
        setLocating(false)
        setStep(STEP.GEO_YES)
      },
      () => {
        setLocating(false)
        setStep(STEP.GEO_NO)
      },
      { timeout: 8000 }
    )
  }
  const declineGeo = () => setStep(STEP.GEO_NO)

  const submit = async () => {
    setSubmitting(true)
    setError('')
    try {
      const fields = {
        campaign: activeCampaign ? activeCampaign.id : '',
        // Left out entirely (createOrQueue drops empty-string fields) when
        // geolocation was declined/failed -- there's no wilaya picker in
        // this flow to fall back to. NeedCreateSerializer.validate() then
        // assigns a fallback wilaya itself (Alger when authorized for the
        // campaign, otherwise the first authorized one) and flags
        // has_no_location, so submission never dead-ends on this alone;
        // the map groups those into one "sans localisation" bubble with a
        // listen button per SOS instead of scattering them under a wilaya
        // the reporter never actually confirmed (see NeedsList.jsx).
        wilaya: wilayaId || '',
        urgency: 'critical',
        title: t('createNeed.fallbackTitle'),
        latitude: gps?.latitude ?? '',
        longitude: gps?.longitude ?? '',
      }
      const files = voiceBlob ? { voice_file: new File([voiceBlob], 'voice.webm', { type: voiceBlob.type }) } : {}
      // Own endpoint (not /api/needs/, which CreateNeed.jsx keeps using
      // unaffected) -- this one additionally re-checks Algeria-or-admin
      // server-side (see NeedViewSet.create_via_voice_guide) regardless of
      // the sitewide geo_restrict_writes_to_algeria toggle, since this
      // feature is still pending approval and unlinked from the site.
      const result = await createOrQueue({ type: 'need', endpoint: '/api/needs/voice-guide/', fields, files })
      if (result.queued) {
        setStep(STEP.DONE)
        return
      }
      const need = result.data
      saveNeedToken(need.id, { access_token: need.access_token, location_viewer_share_token: need.location_viewer_share_token })
      refreshConfig()
      setCreatedNeedId(need.id)
      setStep(STEP.DONE)
    } catch (err) {
      setError(translateApiError(err, t))
    } finally {
      setSubmitting(false)
    }
  }

  // Not linked from the site yet -- reachable only via a direct link for
  // testing (see Home.jsx, which deliberately no longer has this link).
  // config.voice_guide_available mirrors the same Algeria-or-admin check
  // NeedViewSet.create_via_voice_guide re-checks at submission time; shown
  // upfront so a non-eligible visitor sees this immediately instead of
  // going through all 7 steps only to be rejected at the last one.
  // Strictly === false (not just falsy) so the still-loading default
  // config (before /config/ resolves) never flashes this message for an
  // eligible visitor.
  if (config.voice_guide_available === false) {
    return (
      <section className="voice-guide-page">
        <h2>{t('voiceGuide.title')}</h2>
        <p className="voice-guide-caption">{t('apiErrors.voiceGuideAlgeriaOnly')}</p>
        <Link to="/" className="btn">
          {t('voiceGuide.backHome')}
        </Link>
      </section>
    )
  }

  return (
    <section className="voice-guide-page">
      <h2>{t('voiceGuide.title')}</h2>

      {step === STEP.LANG && (
        <div className="voice-guide-step">
          <p className="voice-guide-caption">{t('voiceGuide.step0Caption')}</p>
          <div className="voice-guide-actions">
            <button type="button" className="btn btn-primary" onClick={() => chooseLang('fr')}>
              {t('voiceGuide.langFr')}
            </button>
            <button type="button" className="btn" onClick={() => chooseLang('ar')}>
              {t('voiceGuide.langAr')}
            </button>
          </div>
          {repeatsExhausted && <p className="hint">{t('voiceGuide.stillWaitingHint')}</p>}
        </div>
      )}

      {step === STEP.INTRO && (
        <div className="voice-guide-step">
          <p className="voice-guide-caption">{t('voiceGuide.step1Caption')}</p>
          {!recording ? (
            <button type="button" className="btn btn-primary btn-icon" onClick={startRecording}>
              <IconMic width={18} height={18} strokeWidth={1.75} /> {t('voiceGuide.startRecording')}
            </button>
          ) : (
            <>
              <p className="dialog-message">
                <span className="recording-dot" /> {t('voiceGuide.recordingInProgress', { seconds })}
              </p>
              <button type="button" className="btn btn-danger" onClick={finishRecording}>
                {t('voiceGuide.finishRecording')}
              </button>
            </>
          )}
        </div>
      )}

      {step === STEP.GEO_ASK && (
        <div className="voice-guide-step">
          <p className="voice-guide-caption">{t('voiceGuide.step2Caption')}</p>
          <div className="voice-guide-actions">
            <button type="button" className="btn btn-primary" onClick={acceptGeo} disabled={locating}>
              {t('common.yes')}
            </button>
            <button type="button" className="btn" onClick={declineGeo} disabled={locating}>
              {t('common.no')}
            </button>
          </div>
          {repeatsExhausted && <p className="hint">{t('voiceGuide.stillWaitingHint')}</p>}
        </div>
      )}

      {step === STEP.GEO_YES && (
        <div className="voice-guide-step">
          <p className="voice-guide-caption">{t('voiceGuide.step3Caption')}</p>
        </div>
      )}

      {step === STEP.GEO_NO && (
        <div className="voice-guide-step">
          <p className="voice-guide-caption">{t('voiceGuide.step4Caption')}</p>
        </div>
      )}

      {step === STEP.VALIDATE && (
        <div className="voice-guide-step">
          <p className="voice-guide-caption">{t('voiceGuide.step5Caption')}</p>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? t('voiceGuide.submitting') : t('voiceGuide.validate')}
          </button>
          {error && <p className="error">{error}</p>}
          {repeatsExhausted && <p className="hint">{t('voiceGuide.stillWaitingHint')}</p>}
        </div>
      )}

      {step === STEP.DONE && (
        <div className="voice-guide-step">
          <IconCheckCircle width={40} height={40} />
          <p className="voice-guide-caption">{t('voiceGuide.step6Caption')}</p>
          <div className="voice-guide-actions">
            {createdNeedId && (
              <button type="button" className="btn btn-primary" onClick={() => navigate(`/needs/${createdNeedId}`)}>
                {t('voiceGuide.viewListing')}
              </button>
            )}
            <Link to="/" className="btn">
              {t('voiceGuide.backHome')}
            </Link>
          </div>
        </div>
      )}
    </section>
  )
}
