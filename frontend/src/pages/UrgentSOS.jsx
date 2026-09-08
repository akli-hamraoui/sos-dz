import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api, apiUpload, createOrQueue } from '../api'
import { translateApiError } from '../apiErrors'
import { IconCheckCircle, IconMic } from '../icons'
import { audioUrlFor } from '../voiceGuide'

const STEP = { INTRO: 0, RECORD: 1, PREVIEW: 2, LOCATION: 3, ANALYZE: 4, REVIEW: 5, DONE: 6 }
const MAX_SECONDS = 180

function AudioGuide({ lang, step }) {
  const { t } = useTranslation()
  const ref = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [supported, setSupported] = useState(true)

  useEffect(() => {
    const audio = ref.current
    return () => {
      if (audio) {
        audio.pause()
        audio.currentTime = 0
      }
    }
  }, [lang, step])

  const toggle = () => {
    const audio = ref.current
    if (!audio) return
    if (audio.paused) {
      audio.play().then(() => setPlaying(true)).catch(() => setSupported(false))
    } else {
      audio.pause()
      setPlaying(false)
    }
  }

  return (
    <div className="urgent-sos-audio">
      <audio
        ref={ref}
        src={audioUrlFor(lang, step)}
        preload="metadata"
        onEnded={() => setPlaying(false)}
        onError={() => setSupported(false)}
      />
      <button type="button" className="urgent-sos-audio-btn" onClick={toggle} aria-label={playing ? t('urgentSos.pauseAudio') : t('urgentSos.playAudio')}>
        {playing ? '⏸' : '▶'} {playing ? t('urgentSos.pauseAudio') : t('urgentSos.playAudio')}
      </button>
      {!supported && <span className="urgent-sos-audio-fallback">{t('urgentSos.audioUnavailable')}</span>}
    </div>
  )
}

const fallbackData = {
  title: 'SOS urgent',
  contact_name: 'Anonyme',
  contact_phone: '',
  estimated_quantity: '',
  commune: '',
  location_description: 'Sans localisation',
  organization_or_person_name: '',
  description: '',
}

export default function UrgentSOS() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { config, campaigns, saveNeedToken, refreshConfig } = useApp()
  const [step, setStep] = useState(STEP.INTRO)
  const [lang, setLang] = useState('fr')
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [voiceBlob, setVoiceBlob] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [gps, setGps] = useState(null)
  const [wilayaId, setWilayaId] = useState(null)
  const [locating, setLocating] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [extracted, setExtracted] = useState(fallbackData)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [createdNeedId, setCreatedNeedId] = useState(null)
  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)

  const activeCampaign = useMemo(() => campaigns.find((c) => c.status === 'active'), [campaigns])

  useEffect(() => {
    return () => {
      clearInterval(timerRef.current)
      streamRef.current?.getTracks().forEach((track) => track.stop())
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  if (config.voice_guide_available === false) return <Navigate to="/" replace />

  const chooseLanguage = (value) => {
    setLang(value)
    setError('')
  }

  const startRecording = async () => {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError(t('urgentSos.microphoneUnsupported'))
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported?.(type)) || ''
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data)
      }
      recorder.onerror = () => {
        setRecording(false)
        setError(t('urgentSos.recordingError'))
      }
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        if (!blob.size) {
          setError(t('urgentSos.emptyAudio'))
          return
        }
        setVoiceBlob(blob)
        setPreviewUrl(URL.createObjectURL(blob))
        setStep(STEP.PREVIEW)
      }
      recorderRef.current = recorder
      setSeconds(0)
      setRecording(true)
      recorder.start(250)
      timerRef.current = setInterval(() => {
        setSeconds((value) => {
          if (value + 1 >= MAX_SECONDS) {
            recorder.stop()
            clearInterval(timerRef.current)
            setRecording(false)
          }
          return value + 1
        })
      }, 1000)
    } catch (err) {
      const message = err?.name === 'NotAllowedError' ? t('urgentSos.microphoneDenied') : t('urgentSos.microphoneUnavailable')
      setError(message)
    }
  }

  const stopRecording = () => {
    clearInterval(timerRef.current)
    setRecording(false)
    if (recorderRef.current?.state !== 'inactive') recorderRef.current.stop()
  }

  const restartRecording = () => {
    setVoiceBlob(null)
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreviewUrl('')
    setTranscript('')
    setExtracted(fallbackData)
    setError('')
    setStep(STEP.RECORD)
  }

  const chooseLocation = () => {
    setError('')
    if (!navigator.geolocation) {
      setStep(STEP.ANALYZE)
      analyzeVoice()
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(async (position) => {
      const { latitude, longitude } = position.coords
      setGps({ latitude, longitude })
      try {
        const suggestion = await api(`/wilayas/nearest/?lat=${latitude}&lon=${longitude}`)
        setWilayaId(suggestion.id)
      } catch {
        // GPS remains useful even when nearest-wilaya lookup is unavailable.
      } finally {
        setLocating(false)
        setStep(STEP.ANALYZE)
        analyzeVoice()
      }
    }, () => {
      setLocating(false)
      setStep(STEP.ANALYZE)
      analyzeVoice()
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 })
  }

  const analyzeVoice = async () => {
    if (!voiceBlob) return
    setBusy(true)
    setError('')
    try {
      const form = new FormData()
      form.append('audio', new File([voiceBlob], 'urgent-sos.webm', { type: voiceBlob.type || 'audio/webm' }))
      form.append('language', lang)
      const result = await apiUpload('/needs/voice-guide/analyze/', form)
      const data = { ...fallbackData, ...(result.extraction || {}) }
      data.title = data.title || fallbackData.title
      data.contact_name = data.contact_name || fallbackData.contact_name
      data.location_description = data.location_description || fallbackData.location_description
      data.description = data.description || result.transcript || ''
      setTranscript(result.transcript || '')
      setExtracted(data)
      setStep(STEP.REVIEW)
    } catch (err) {
      // The recording itself remains available; a failed AI analysis must not
      // prevent the reporter from retrying or continuing with safe fallbacks.
      setTranscript('')
      setExtracted(fallbackData)
      setError(translateApiError(err, t))
      setStep(STEP.REVIEW)
    } finally {
      setBusy(false)
    }
  }

  const updateField = (key, value) => setExtracted((current) => ({ ...current, [key]: value }))

  const submit = async () => {
    if (!voiceBlob || !activeCampaign) {
      setError(t('urgentSos.campaignUnavailable'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const fields = {
        campaign: activeCampaign.id,
        wilaya: wilayaId || '',
        urgency: 'critical',
        title: extracted.title || 'SOS urgent',
        estimated_quantity: extracted.estimated_quantity || '',
        commune: extracted.commune || '',
        location_description: extracted.location_description || 'Sans localisation',
        contact_name: extracted.contact_name || 'Anonyme',
        contact_phone: extracted.contact_phone || '',
        organization_or_person_name: extracted.organization_or_person_name || '',
        description: extracted.description || transcript || 'SOS urgent — message vocal joint.',
        latitude: gps?.latitude ?? '',
        longitude: gps?.longitude ?? '',
        // Guided SOS is deliberately published with a safe recovery code
        // omitted: the access token returned by the existing Need flow is
        // the primary recovery mechanism for this emergency path.
      }
      const result = await createOrQueue({
        type: 'need',
        endpoint: '/api/needs/voice-guide/',
        fields,
        files: { voice_file: new File([voiceBlob], 'urgent-sos.webm', { type: voiceBlob.type || 'audio/webm' }) },
      })
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
      setBusy(false)
    }
  }

  const pageTitle = t('urgentSos.title')

  return (
    <section className="urgent-sos-page">
      <div className="urgent-sos-shell">
        <Link to="/" className="urgent-sos-back">← {t('urgentSos.back')}</Link>
        <div className="urgent-sos-kicker">🚨 {t('urgentSos.kicker')}</div>
        <div className="urgent-sos-hero">
          <div className="urgent-sos-icon" aria-hidden="true"><IconMic width={34} height={34} /></div>
          <div>
            <h1>{pageTitle}</h1>
            <p>{t('urgentSos.subtitle')}</p>
          </div>
        </div>

        <div className="urgent-sos-progress" aria-label={t('urgentSos.progressLabel')}>
          {[STEP.INTRO, STEP.RECORD, STEP.PREVIEW, STEP.LOCATION, STEP.REVIEW].map((item) => (
            <span key={item} className={step >= item ? 'active' : ''} />
          ))}
        </div>

        {step === STEP.INTRO && (
          <div className="urgent-sos-card">
            <h2>{t('urgentSos.introTitle')}</h2>
            <p>{t('urgentSos.introText')}</p>
            <AudioGuide lang={lang} step={0} />
            <div className="urgent-sos-language">
              <button type="button" className={lang === 'fr' ? 'selected' : ''} onClick={() => chooseLanguage('fr')}>Français</button>
              <button type="button" className={lang === 'ar' ? 'selected' : ''} onClick={() => chooseLanguage('ar')}>العربية</button>
            </div>
            <button type="button" className="urgent-sos-primary" onClick={() => setStep(STEP.RECORD)}>
              {t('urgentSos.continue')}
            </button>
          </div>
        )}

        {step === STEP.RECORD && (
          <div className="urgent-sos-card">
            <div className="urgent-sos-step-label">{t('urgentSos.step', { current: 1, total: 4 })}</div>
            <h2>{t('urgentSos.recordTitle')}</h2>
            <p>{t('urgentSos.recordText')}</p>
            <AudioGuide lang={lang} step={1} />
            <div className={recording ? 'urgent-sos-recording active' : 'urgent-sos-recording'}>
              <span className="urgent-sos-recording-dot" aria-hidden="true" />
              <strong>{recording ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : t('urgentSos.ready')}</strong>
            </div>
            {recording ? (
              <button type="button" className="urgent-sos-danger" onClick={stopRecording}>⏹ {t('urgentSos.stop')}</button>
            ) : (
              <button type="button" className="urgent-sos-primary urgent-sos-record-button" onClick={startRecording}>
                <IconMic width={22} height={22} /> {t('urgentSos.start')}
              </button>
            )}
          </div>
        )}

        {step === STEP.PREVIEW && (
          <div className="urgent-sos-card">
            <div className="urgent-sos-step-label">{t('urgentSos.step', { current: 2, total: 4 })}</div>
            <h2>{t('urgentSos.previewTitle')}</h2>
            <p>{t('urgentSos.previewText')}</p>
            <audio className="urgent-sos-preview" controls src={previewUrl} />
            <div className="urgent-sos-actions">
              <button type="button" className="urgent-sos-secondary" onClick={restartRecording}>{t('urgentSos.rerecord')}</button>
              <button type="button" className="urgent-sos-primary" onClick={() => setStep(STEP.LOCATION)}>{t('urgentSos.continue')}</button>
            </div>
          </div>
        )}

        {step === STEP.LOCATION && (
          <div className="urgent-sos-card">
            <div className="urgent-sos-step-label">{t('urgentSos.step', { current: 3, total: 4 })}</div>
            <h2>{t('urgentSos.locationTitle')}</h2>
            <p>{t('urgentSos.locationText')}</p>
            <AudioGuide lang={lang} step={2} />
            <div className="urgent-sos-actions">
              <button type="button" className="urgent-sos-secondary" onClick={() => { setStep(STEP.ANALYZE); analyzeVoice() }} disabled={locating || busy}>
                {t('urgentSos.noLocation')}
              </button>
              <button type="button" className="urgent-sos-primary" onClick={chooseLocation} disabled={locating || busy}>
                {locating ? t('urgentSos.locating') : t('urgentSos.useLocation')}
              </button>
            </div>
          </div>
        )}

        {step === STEP.ANALYZE && (
          <div className="urgent-sos-card urgent-sos-center">
            <div className="urgent-sos-loader" aria-hidden="true" />
            <h2>{t('urgentSos.analyzingTitle')}</h2>
            <p>{t('urgentSos.analyzingText')}</p>
          </div>
        )}

        {step === STEP.REVIEW && (
          <div className="urgent-sos-card">
            <div className="urgent-sos-step-label">{t('urgentSos.step', { current: 4, total: 4 })}</div>
            <h2>{t('urgentSos.reviewTitle')}</h2>
            <p>{t('urgentSos.reviewText')}</p>
            {transcript && (
              <details className="urgent-sos-transcript">
                <summary>{t('urgentSos.showTranscript')}</summary>
                <p>{transcript}</p>
              </details>
            )}
            <div className="urgent-sos-fields">
              <label>{t('urgentSos.name')}<input value={extracted.contact_name || ''} onChange={(e) => updateField('contact_name', e.target.value)} /></label>
              <label>{t('urgentSos.phone')}<input inputMode="tel" value={extracted.contact_phone || ''} onChange={(e) => updateField('contact_phone', e.target.value)} /></label>
              <label>{t('urgentSos.need')}<input value={extracted.title || ''} onChange={(e) => updateField('title', e.target.value)} /></label>
              <label>{t('urgentSos.location')}<input value={extracted.location_description || ''} onChange={(e) => updateField('location_description', e.target.value)} /></label>
              <label>{t('urgentSos.description')}<textarea rows="4" value={extracted.description || ''} onChange={(e) => updateField('description', e.target.value)} /></label>
            </div>
            {error && <p className="urgent-sos-error" role="alert">{error}</p>}
            <div className="urgent-sos-actions">
              <button type="button" className="urgent-sos-secondary" onClick={restartRecording} disabled={busy}>{t('urgentSos.restart')}</button>
              <button type="button" className="urgent-sos-primary urgent-sos-confirm" onClick={submit} disabled={busy}>
                🚨 {busy ? t('urgentSos.sending') : t('urgentSos.confirm')}
              </button>
            </div>
          </div>
        )}

        {step === STEP.DONE && (
          <div className="urgent-sos-card urgent-sos-center">
            <IconCheckCircle width={52} height={52} />
            <h2>{t('urgentSos.doneTitle')}</h2>
            <p>{t('urgentSos.doneText')}</p>
            <div className="urgent-sos-actions">
              {createdNeedId && <button type="button" className="urgent-sos-primary" onClick={() => navigate(`/needs/${createdNeedId}`)}>{t('urgentSos.viewNeed')}</button>}
              <Link to="/" className="urgent-sos-secondary">{t('urgentSos.backHome')}</Link>
            </div>
          </div>
        )}

        {error && step !== STEP.REVIEW && <p className="urgent-sos-error" role="alert">{error}</p>}
      </div>
    </section>
  )
}
