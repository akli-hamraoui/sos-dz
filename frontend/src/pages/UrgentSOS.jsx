import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api, apiUpload } from '../api'
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
        audio.load()
      }
    }
  }, [lang, step])

  const toggle = () => {
    const audio = ref.current
    if (!audio) return
    if (audio.paused) {
      setSupported(true)
      audio.load()
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
        preload="auto"
        playsInline
        onLoadedData={() => setSupported(true)}
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
  const { config, campaigns, activeCampaignWilayas, saveNeedToken, refreshConfig } = useApp()
  const [step, setStep] = useState(STEP.INTRO)
  const [lang, setLang] = useState('fr')
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [voiceBlob, setVoiceBlob] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [gps, setGps] = useState(null)
  const [wilayaId, setWilayaId] = useState(null)
  const [locating, setLocating] = useState(false)
  const [locationStatus, setLocationStatus] = useState('idle')
  const [locationAccuracy, setLocationAccuracy] = useState(null)
  const [transcript, setTranscript] = useState('')
  const [extracted, setExtracted] = useState(fallbackData)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [createdNeedId, setCreatedNeedId] = useState(null)
  const [recoveryCode, setRecoveryCode] = useState('')
  const [tokenCopied, setTokenCopied] = useState(false)
  const [accessToken, setAccessToken] = useState('')
  const [accessTokenCopied, setAccessTokenCopied] = useState(false)
  const [tokenSaved, setTokenSaved] = useState(false)
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

  const chooseLocation = async () => {
    setError('')
    setLocationStatus('locating')
    setLocationAccuracy(null)

    if (!navigator.geolocation) {
      setLocationStatus('error')
      setError(t('urgentSos.locationUnsupported'))
      return
    }

    const getPosition = (options) => new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options)
    })

    setLocating(true)
    try {
      let position
      try {
        // First try the precise GPS/Wi-Fi fix. A short cached fix is accepted
        // so Android does not wait unnecessarily when a recent position exists.
        position = await getPosition({
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 30000,
        })
      } catch (firstError) {
        // A high-accuracy request can time out indoors or on some Android
        // devices. Retry with the lower-power provider before declaring failure.
        position = await getPosition({
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 300000,
        })
      }

      const { latitude, longitude, accuracy } = position.coords
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error('invalid-position')
      }

      setGps({ latitude, longitude })
      setLocationAccuracy(Number.isFinite(accuracy) ? Math.round(accuracy) : null)

      // The normal user flow remains Algeria-only. Admins testing this
      // dedicated SOS voice page may keep their real GPS coordinates even
      // when physically abroad; the backend applies the same scope server-side.
      const insideAlgeria =
        latitude >= 18.9 && latitude <= 37.3 &&
        longitude >= -8.7 && longitude <= 12.0

      if (!insideAlgeria && !config.is_admin) {
        setGps(null)
        setWilayaId(null)
        setLocationStatus('outside')
        setError(t('urgentSos.locationOutsideAlgeria'))
        return
      }

      if (!wilayaId && insideAlgeria) {
        try {
          const suggestion = await api(`/wilayas/nearest/?lat=${latitude}&lon=${longitude}`)
          setWilayaId(suggestion.id || null)
        } catch {
          // Manual wilaya selection and precise GPS remain usable even if
          // the convenience nearest-wilaya lookup is unavailable.
        }
      }

      setLocationStatus('success')
      setStep(STEP.ANALYZE)
      await analyzeVoice()
    } catch (geoError) {
      setGps(null)
      setWilayaId(null)
      setLocationStatus('error')
      const message =
        geoError?.code === 1 ? t('urgentSos.locationDenied') :
        geoError?.code === 2 ? t('urgentSos.locationUnavailable') :
        geoError?.code === 3 ? t('urgentSos.locationTimeout') :
        t('urgentSos.locationError')
      setError(message)
    } finally {
      setLocating(false)
    }
  }

  const goToPreviousStep = () => {
    setError('')
    if (step === STEP.RECORD) return setStep(STEP.INTRO)
    if (step === STEP.PREVIEW) return setStep(STEP.RECORD)
    if (step === STEP.LOCATION) return setStep(STEP.PREVIEW)
    if (step === STEP.REVIEW) return setStep(STEP.LOCATION)
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
      // Do not put the guided SOS publication into the generic offline queue:
      // the reporter must receive the recovery password and access token
      // immediately on this screen. A queued emergency submission cannot
      // safely promise that those credentials have been saved.
      const submissionRecoveryCode = `voice-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
      setRecoveryCode(submissionRecoveryCode)
      const formData = new FormData()
      const fields = {
        campaign: activeCampaign.id,
        wilaya: wilayaId || '',
        urgency: 'critical',
        title: extracted.title || 'SOS urgent',
        estimated_quantity: extracted.estimated_quantity || '',
        commune: extracted.commune || '',
        contact_name: extracted.contact_name || 'Anonyme',
        contact_phone: extracted.contact_phone || '',
        organization_or_person_name: extracted.organization_or_person_name || '',
        // Keep the detected location and the full spoken description so no
        // useful detail from the transcription is silently lost.
        location_description: [extracted.location_description, extracted.description || transcript].filter(Boolean).join(' — ') || 'Sans localisation',
        latitude: gps?.latitude ?? '',
        longitude: gps?.longitude ?? '',
        recovery_code: submissionRecoveryCode,
      }
      Object.entries(fields).forEach(([key, value]) => {
        if (value !== null && value !== undefined && value !== '') formData.append(key, value)
      })
      formData.append(
        'voice_file',
        new File([voiceBlob], 'urgent-sos.webm', { type: voiceBlob.type || 'audio/webm' }),
      )
      const need = await apiUpload('/needs/voice-guide/', formData)
      const returnedRecoveryCode = need.recovery_code || submissionRecoveryCode
      const returnedAccessToken = need.access_token || ''
      setRecoveryCode(returnedRecoveryCode)
      setAccessToken(returnedAccessToken)
      setTokenCopied(false)
      setAccessTokenCopied(false)
      if (!returnedAccessToken) {
        throw new Error(t('urgentSos.tokenMissing'))
      }
      setTokenSaved(Boolean(returnedAccessToken))
      if (need.id) {
        await Promise.resolve(saveNeedToken(need.id, {
          access_token: returnedAccessToken,
          location_viewer_share_token: need.location_viewer_share_token,
        }))
        setCreatedNeedId(need.id)
      }
      refreshConfig()
      setStep(STEP.DONE)
    } catch (err) {
      setError(translateApiError(err, t))
    } finally {
      setBusy(false)
    }
  }

  const copyAccessToken = async () => {
    if (!recoveryCode) return
    try {
      await navigator.clipboard.writeText(recoveryCode)
      setTokenCopied(true)
      window.setTimeout(() => setTokenCopied(false), 2200)
    } catch {
      setError(t('urgentSos.copyTokenFailed'))
    }
  }

  const copyStoredAccessToken = async () => {
    if (!accessToken) return
    try {
      await navigator.clipboard.writeText(accessToken)
      setAccessTokenCopied(true)
      window.setTimeout(() => setAccessTokenCopied(false), 2200)
    } catch {
      setError(t('urgentSos.copyTokenFailed'))
    }
  }

  const pageTitle = t('urgentSos.title')

  return (
    <section className="urgent-sos-page">
      <div className="urgent-sos-shell">
        <div className="urgent-sos-kicker">🚨 {t('urgentSos.kicker')}</div>
        <div className="urgent-sos-hero">
          <div className="urgent-sos-icon" aria-hidden="true"><IconMic width={34} height={34} /></div>
          <div>
            <h1>{pageTitle}</h1>
            <p>{t('urgentSos.subtitle')}</p>
          </div>
        </div>

        <div className="urgent-sos-stepper" aria-label={t('urgentSos.progressLabel')}>
          {[
            [STEP.INTRO, t('urgentSos.stepIntro')],
            [STEP.RECORD, t('urgentSos.stepRecord')],
            [STEP.PREVIEW, t('urgentSos.stepPreview')],
            [STEP.LOCATION, t('urgentSos.stepLocation')],
            [STEP.REVIEW, t('urgentSos.stepReview')],
          ].map(([item, label], index) => (
            <div key={item} className={step >= item ? 'done' : ''} data-current={step === item}>
              <span>{index + 1}</span>
              <small>{label}</small>
            </div>
          ))}
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
              <div className="urgent-sos-actions urgent-sos-record-actions">
                <button type="button" className="urgent-sos-secondary urgent-sos-previous" onClick={goToPreviousStep}>{t('urgentSos.previous')}</button>
                <button type="button" className="urgent-sos-danger" onClick={stopRecording}>⏹ {t('urgentSos.stop')}</button>
              </div>
            ) : (
              <div className="urgent-sos-actions urgent-sos-record-actions">
              <button type="button" className="urgent-sos-secondary urgent-sos-previous" onClick={goToPreviousStep}>{t('urgentSos.previous')}</button>
              <button type="button" className="urgent-sos-primary urgent-sos-record-button" onClick={startRecording}>
                <IconMic width={22} height={22} /> {t('urgentSos.start')}
              </button>
              </div>
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
              <button type="button" className="urgent-sos-secondary urgent-sos-previous" onClick={goToPreviousStep}>{t('urgentSos.previous')}</button>
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
            <div className="urgent-sos-wilaya-field">
              <label htmlFor="urgent-sos-wilaya">{t('urgentSos.wilayaOptional')}</label>
              <select
                id="urgent-sos-wilaya"
                value={wilayaId || ''}
                onChange={(e) => setWilayaId(e.target.value || null)}
              >
                <option value="">{t('urgentSos.wilayaPlaceholder')}</option>
                {activeCampaignWilayas.map((wilaya) => (
                  <option key={wilaya.id} value={wilaya.id}>{wilaya.name}</option>
                ))}
              </select>
              <small>{t('urgentSos.wilayaHelp')}</small>
            </div>
            <AudioGuide lang={lang} step={2} />
            {locationStatus === 'success' && gps && (
              <div className="urgent-sos-location-status success" role="status">
                ✓ {t('urgentSos.locationDetected')}
                {locationAccuracy ? ` · ±${locationAccuracy} m` : ''}
              </div>
            )}
            {locationStatus === 'outside' && (
              <div className="urgent-sos-location-status warning" role="status">
                ⚠️ {t('urgentSos.locationOutsideAlgeria')}
              </div>
            )}
            {locationStatus === 'error' && error && (
              <div className="urgent-sos-location-status error" role="alert">{error}</div>
            )}
            <div className="urgent-sos-actions">
              <button type="button" className="urgent-sos-secondary" onClick={goToPreviousStep} disabled={locating || busy}>{t('urgentSos.previous')}</button>
              <button type="button" className="urgent-sos-secondary" onClick={() => { setError(''); setLocationStatus('skipped'); setGps(null); setStep(STEP.ANALYZE); analyzeVoice() }} disabled={locating || busy}>
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
          <div className="urgent-sos-card urgent-sos-review-card">
            <div className="urgent-sos-step-label">{t('urgentSos.step', { current: 4, total: 4 })}</div>
            <h2>{t('urgentSos.reviewTitle')}</h2>
            <p>{t('urgentSos.reviewText')}</p>
            <AudioGuide lang={lang} step={7} />
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
              <button type="button" className="urgent-sos-secondary" onClick={goToPreviousStep} disabled={busy}>{t('urgentSos.previous')}</button>
              <button type="button" className="urgent-sos-secondary" onClick={restartRecording} disabled={busy}>{t('urgentSos.restart')}</button>
              <button type="button" className="urgent-sos-primary urgent-sos-confirm" onClick={submit} disabled={busy}>
                🚨 {busy ? t('urgentSos.sending') : t('urgentSos.confirm')}
              </button>
            </div>
          </div>
        )}

        {step === STEP.DONE && (
          <div className="urgent-sos-card urgent-sos-center urgent-sos-done-card">
            <IconCheckCircle width={52} height={52} />
            <div className="urgent-sos-final-badge">✓ {t('urgentSos.doneTitle')}</div>
            <h2>{t('urgentSos.doneTitle')}</h2>
            <p>{t('urgentSos.doneText')}</p>
            <div className="urgent-sos-final-warning" role="alert">
              🔐 <strong>{t('urgentSos.finalPasswordWarning')}</strong>
            </div>
            <AudioGuide lang={lang} step={8} />
            {tokenSaved && <p className="urgent-sos-token-saved" role="status">✓ {t('urgentSos.tokenSaved')}</p>}
            {recoveryCode && (
              <div className="urgent-sos-token-box" role="status">
                <div className="urgent-sos-token-title">{t('urgentSos.tokenTitle')}</div>
                <p className="urgent-sos-token-warning">{t('urgentSos.tokenWarning')}</p>
                <div className="urgent-sos-token-row">
                  <strong className="urgent-sos-token">{recoveryCode}</strong>
                  <button type="button" className="urgent-sos-copy-token" onClick={copyAccessToken} aria-label={t('urgentSos.copyToken')}>
                    📋 {tokenCopied ? t('urgentSos.tokenCopied') : t('urgentSos.copyToken')}
                  </button>
                </div>
              </div>
            )}
            {accessToken && (
              <div className="urgent-sos-token-box urgent-sos-access-token-box" role="status">
                <div className="urgent-sos-token-title">{t('urgentSos.accessTokenTitle')}</div>
                <p className="urgent-sos-token-warning">{t('urgentSos.accessTokenWarning')}</p>
                <div className="urgent-sos-token-row">
                  <strong className="urgent-sos-token">{accessToken}</strong>
                  <button type="button" className="urgent-sos-copy-token" onClick={copyStoredAccessToken} aria-label={t('urgentSos.copyAccessToken')}>
                    📋 {accessTokenCopied ? t('urgentSos.accessTokenCopied') : t('urgentSos.copyAccessToken')}
                  </button>
                </div>
              </div>
            )}
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
