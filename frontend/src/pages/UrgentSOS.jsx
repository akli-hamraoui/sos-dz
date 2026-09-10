import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api, apiUpload } from '../api'
import { translateApiError } from '../apiErrors'
import { IconMic } from '../icons'
import { audioUrlFor } from '../voiceGuide'
import '../urgent-sos-wizard-fixes.css'

const S = { INTRO: 0, RECORD: 1, PREVIEW: 2, LOCATION: 3 }
const MAX = 180

function Audio({ lang, step }) {
  const { t } = useTranslation()
  const audioRef = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [available, setAvailable] = useState(true)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    let cancelled = false
    setPlaying(false)
    setAvailable(true)
    audio.pause()
    audio.currentTime = 0
    audio.src = audioUrlFor(lang, step)
    audio.load()

    // Autoplay rejection is expected on many mobile browsers. It must never
    // be treated as an unavailable/missing audio file.
    const timer = setTimeout(() => {
      audio.play()
        .then(() => {
          if (!cancelled) setPlaying(true)
        })
        .catch(() => {
          if (!cancelled) setPlaying(false)
        })
    }, 0)

    return () => {
      cancelled = true
      clearTimeout(timer)
      audio.pause()
      audio.currentTime = 0
    }
  }, [lang, step])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return

    if (audio.paused) {
      setAvailable(true)
      audio.currentTime = 0
      audio.play()
        .then(() => setPlaying(true))
        .catch(() => setPlaying(false))
      return
    }

    audio.pause()
    setPlaying(false)
  }

  return (
    <div className="urgent-sos-audio">
      <audio
        ref={audioRef}
        preload="auto"
        playsInline
        onCanPlay={() => setAvailable(true)}
        onError={() => {
          setPlaying(false)
          setAvailable(false)
        }}
        onEnded={() => setPlaying(false)}
      />
      <button type="button" className="urgent-sos-audio-btn" onClick={toggle}>
        {playing ? '⏸' : '▶'} {playing ? t('urgentSos.pauseAudio') : t('urgentSos.playAudio')}
      </button>
      {!available && (
        <span className="urgent-sos-audio-fallback">
          {t('urgentSos.audioUnavailable')}
        </span>
      )}
    </div>
  )
}

function Chevron() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
      <path
        d="m6 9 6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default function UrgentSOS() {
  const { t } = useTranslation()
  const {
    config,
    campaigns,
    activeCampaignWilayas,
    saveNeedToken,
    refreshConfig,
  } = useApp()

  const campaign = useMemo(
    () => campaigns.find((c) => c.status === 'active'),
    [campaigns]
  )

  const [step, setStep] = useState(S.INTRO)
  const [lang, setLang] = useState('fr')
  const [rec, setRec] = useState(false)
  const [count, setCount] = useState(0)
  const [sec, setSec] = useState(0)
  const [recordedDuration, setRecordedDuration] = useState(0)
  const [blob, setBlob] = useState(null)
  const [url, setUrl] = useState('')
  const [gps, setGps] = useState(null)
  const [acc, setAcc] = useState(null)
  const [wilaya, setWilaya] = useState(null)
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [loc, setLoc] = useState('idle')
  const [decision, setDecision] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [token, setToken] = useState('')
  const [copied, setCopied] = useState(false)

  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const countdownRef = useRef(null)
  const discardOnStopRef = useRef(false)
  const audioUrlRef = useRef('')
  const elapsedRef = useRef(0)
  const wilayaRef = useRef(null)

  useEffect(() => {
    wilayaRef.current = wilaya
  }, [wilaya])

  useEffect(() => {
    const stopEverything = () => {
      clearInterval(timerRef.current)
      clearInterval(countdownRef.current)
      timerRef.current = null
      countdownRef.current = null

      const recorder = recorderRef.current
      if (recorder && recorder.state !== 'inactive') {
        discardOnStopRef.current = true
        try {
          recorder.stop()
        } catch {
          // The recorder may already be stopping.
        }
      }

      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    return () => {
      stopEverything()
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    }
  }, [])

  useEffect(() => {
    if (!open) return

    const onPointerDown = (event) => {
      if (!event.target.closest('.urgent-sos-wilaya-combobox')) {
        setOpen(false)
      }
    }

    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  if (config.voice_guide_available === false) {
    return <Navigate to="/" replace />
  }

  const clearTimers = () => {
    clearInterval(timerRef.current)
    clearInterval(countdownRef.current)
    timerRef.current = null
    countdownRef.current = null
  }

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }

  const revokeRecordingUrl = () => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current)
      audioUrlRef.current = ''
    }
  }

  const resetRecording = () => {
    clearTimers()
    releaseStream()
    recorderRef.current = null
    chunksRef.current = []
    elapsedRef.current = 0
    setRec(false)
    setCount(0)
    setSec(0)
  }

  const go = (nextStep) => {
    setError('')
    setOpen(false)
    setStep(nextStep)
  }

  const language = (value) => {
    setLang(value)
    setError('')
    // Audio reacts to the language state change. Keeping playback in the
    // Audio component avoids starting two players for one language switch.
  }

  const finishRecorder = (discard = false) => {
    const recorder = recorderRef.current
    clearTimers()
    setRec(false)

    if (!recorder || recorder.state === 'inactive') {
      releaseStream()
      recorderRef.current = null
      return
    }

    discardOnStopRef.current = discard
    try {
      recorder.stop()
    } catch {
      discardOnStopRef.current = true
      releaseStream()
      recorderRef.current = null
    }
  }

  const cancelCountdown = () => {
    clearInterval(countdownRef.current)
    countdownRef.current = null
    releaseStream()
    chunksRef.current = []
    recorderRef.current = null
    setCount(0)
    setRec(false)
  }

  const start = async () => {
    setError('')

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError(t('urgentSos.microphoneUnsupported'))
      return
    }

    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
      ].find((type) => MediaRecorder.isTypeSupported?.(type)) || ''

      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined
      )

      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []
      discardOnStopRef.current = false
      elapsedRef.current = 0
      setSec(0)
      setCount(2)
      setRec(false)

      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data)
      }

      recorder.onerror = () => {
        clearTimers()
        releaseStream()
        recorderRef.current = null
        setRec(false)
        setCount(0)
        setError(t('urgentSos.recordingError'))
      }

      recorder.onstop = () => {
        const discarded = discardOnStopRef.current
        const duration = Math.min(elapsedRef.current, MAX)
        const recordedChunks = chunksRef.current
        const type = recorder.mimeType || mimeType || 'audio/webm'

        clearTimers()
        releaseStream()
        recorderRef.current = null
        chunksRef.current = []
        setRec(false)
        setCount(0)

        if (discarded) {
          discardOnStopRef.current = false
          return
        }

        const recordedBlob = new Blob(recordedChunks, { type })
        if (!recordedBlob.size) {
          setError(t('urgentSos.emptyAudio'))
          return
        }

        revokeRecordingUrl()
        const objectUrl = URL.createObjectURL(recordedBlob)
        audioUrlRef.current = objectUrl
        setBlob(recordedBlob)
        setUrl(objectUrl)
        setRecordedDuration(duration)
        setStep(S.PREVIEW)
      }

      // Countdown only acquires permission/stream. No MediaRecorder.start()
      // occurs until the counter reaches zero.
      countdownRef.current = setInterval(() => {
        setCount((value) => {
          if (value <= 1) {
            clearInterval(countdownRef.current)
            countdownRef.current = null

            try {
              recorder.start(250)
            } catch {
              discardOnStopRef.current = true
              releaseStream()
              recorderRef.current = null
              setCount(0)
              setRec(false)
              setError(t('urgentSos.recordingError'))
              return 0
            }

            setRec(true)
            elapsedRef.current = 0
            setSec(0)
            timerRef.current = setInterval(() => {
              elapsedRef.current += 1
              setSec(elapsedRef.current)

              if (elapsedRef.current >= MAX) {
                clearInterval(timerRef.current)
                timerRef.current = null
                setRec(false)
                try {
                  if (recorder.state !== 'inactive') recorder.stop()
                } catch {
                  releaseStream()
                }
              }
            }, 1000)

            return 0
          }

          return value - 1
        })
      }, 1000)
    } catch (exception) {
      releaseStream()
      recorderRef.current = null
      setCount(0)
      setRec(false)

      setError(
        exception?.name === 'NotAllowedError'
          ? t('urgentSos.microphoneDenied')
          : t('urgentSos.microphoneUnavailable')
      )
    }
  }

  const stop = () => finishRecorder(false)

  const previous = () => {
    setError('')

    if (step === S.RECORD) {
      if (count > 0) {
        cancelCountdown()
      } else if (rec) {
        finishRecorder(true)
      } else {
        resetRecording()
      }
      setStep(S.INTRO)
      return
    }

    if (step === S.PREVIEW) {
      setStep(S.RECORD)
      return
    }

    if (step === S.LOCATION) {
      setDecision(false)
      setStep(S.PREVIEW)
    }
  }

  const rerecord = () => {
    clearTimers()
    releaseStream()
    recorderRef.current = null
    chunksRef.current = []
    setRec(false)
    setCount(0)
    setSec(0)
    setRecordedDuration(0)
    setBlob(null)
    revokeRecordingUrl()
    setUrl('')
    setStep(S.RECORD)
  }

  const locate = async () => {
    setError('')
    setLoc('locating')
    setOpen(false)

    if (!navigator.geolocation) {
      setLoc('error')
      setError(t('urgentSos.locationUnsupported'))
      return
    }

    const getPosition = (options) =>
      new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, options)
      })

    setBusy(true)

    try {
      let position
      try {
        position = await getPosition({
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 30000,
        })
      } catch {
        position = await getPosition({
          enableHighAccuracy: false,
          timeout: 10000,
          maximumAge: 300000,
        })
      }

      const { latitude, longitude, accuracy } = position.coords
      const inside =
        latitude >= 18.9 &&
        latitude <= 37.3 &&
        longitude >= -8.7 &&
        longitude <= 12

      if (!inside && !config.is_admin) {
        setGps(null)
        setAcc(null)
        setLoc('outside')
        setDecision(false)
        setError(t('urgentSos.locationOutsideAlgeria'))
        return
      }

      setGps({ latitude, longitude })
      setAcc(Number.isFinite(accuracy) ? Math.round(accuracy) : null)
      setLoc('success')
      setDecision(true)

      if (inside) {
        try {
          const nearest = await api(
            `/wilayas/nearest/?lat=${latitude}&lon=${longitude}`
          )
          if (nearest?.id && !wilayaRef.current) {
            setWilaya(nearest.id)
            setSearch(nearest.name || '')
          }
        } catch {
          // Wilaya auto-detection is best-effort; GPS remains valid.
        }
      }
    } catch (exception) {
      setLoc('error')
      setGps(null)
      setAcc(null)
      // Do not erase a manually selected wilaya when GPS fails.
      setDecision(false)
      setError(
        exception?.code === 1
          ? t('urgentSos.locationDenied')
          : exception?.code === 2
            ? t('urgentSos.locationUnavailable')
            : exception?.code === 3
              ? t('urgentSos.locationTimeout')
              : t('urgentSos.locationError')
      )
    } finally {
      setBusy(false)
    }
  }

  const continueWithoutLocation = () => {
    setError('')
    setLoc('skipped')
    setGps(null)
    setAcc(null)
    setOpen(false)
    setDecision(true)
  }

  const submit = async () => {
    if (!blob || !campaign) {
      setError(t('urgentSos.campaignUnavailable'))
      return
    }

    if (config.turnstile_enabled && !(window.__turnstileToken || '')) {
      setError(t('apiErrors.captchaRequired'))
      return
    }

    setBusy(true)
    setError('')

    try {
      const recoveryCode =
        `voice-${globalThis.crypto?.randomUUID?.()?.replaceAll('-', '').slice(0, 12) ||
          Date.now().toString(36)}`

      const formData = new FormData()
      const fields = {
        campaign: campaign.id,
        wilaya: wilaya || '',
        urgency: 'critical',
        title: 'SOS urgent',
        commune: '',
        contact_name: 'Anonyme',
        contact_phone: '',
        organization_or_person_name: '',
        location_description: gps
          ? 'Localisation GPS confirmée'
          : 'Sans localisation',
        latitude: gps?.latitude ?? '',
        longitude: gps?.longitude ?? '',
        recovery_code: recoveryCode,
        turnstile_token: window.__turnstileToken || '',
      }

      Object.entries(fields).forEach(([key, value]) => {
        if (value !== '' && value != null) formData.append(key, value)
      })

      const type = blob.type || 'audio/webm'
      const extension = type.includes('mp4')
        ? 'mp4'
        : type.includes('ogg')
          ? 'ogg'
          : 'webm'

      formData.append(
        'voice_file',
        new File([blob], `urgent-sos.${extension}`, { type })
      )

      const response = await apiUpload('/needs/voice-guide/', formData)
      const accessToken = response?.access_token || ''

      if (!accessToken) {
        setError(t('urgentSos.tokenMissing'))
        return
      }

      setToken(accessToken)

      if (response.id) {
        try {
          await Promise.resolve(
            saveNeedToken(response.id, {
              access_token: accessToken,
              location_viewer_share_token:
                response.location_viewer_share_token,
            })
          )
        } catch {
          // The SOS is already created. Local token persistence is secondary.
        }
      }

      // The POST is the authoritative creation result. Badge/config refresh
      // is deliberately secondary and can never turn a successful SOS into
      // an error screen.
      setSent(true)
      Promise.resolve(refreshConfig()).catch(() => {})
    } catch (exception) {
      setError(translateApiError(exception, t))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!token) return

    try {
      await navigator.clipboard.writeText(token)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch {
      setError(t('urgentSos.copyTokenFailed'))
    }
  }

  const list = (activeCampaignWilayas || [])
    .filter((item) =>
      String(item.name || '')
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase())
    )
    .slice(0, 12)

  const pi = sent ? 3 : Math.max(0, step - 1)

  return (
    <section className="urgent-sos-page">
      <div className="urgent-sos-shell">
        <div className="urgent-sos-kicker">🚨 {t('urgentSos.kicker')}</div>

        <div className="urgent-sos-hero">
          <div className="urgent-sos-icon">
            <IconMic width={34} height={34} />
          </div>
          <div>
            <h1>{t('urgentSos.title')}</h1>
            <p>{t('urgentSos.subtitle')}</p>
          </div>
        </div>

        <div className="urgent-sos-stepper">
          {[
            t('urgentSos.stepRecord'),
            t('urgentSos.stepPreview'),
            t('urgentSos.stepLocation'),
            t('urgentSos.stepReview'),
          ].map((label, index) => (
            <div
              key={label}
              className={index <= pi ? 'done' : ''}
              data-current={index === pi}
            >
              <span>{index + 1}</span>
              <small>{label}</small>
            </div>
          ))}
        </div>

        <div className="urgent-sos-progress">
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className={index <= pi ? 'active' : ''} />
          ))}
        </div>

        {step === S.INTRO && !sent && (
          <div className="urgent-sos-card">
            <h2>{t('urgentSos.introTitle')}</h2>
            <p>{t('urgentSos.introText')}</p>
            <Audio lang={lang} step={0} />

            <div className="urgent-sos-language">
              <button
                type="button"
                className={lang === 'fr' ? 'selected' : ''}
                onClick={() => language('fr')}
              >
                Français
              </button>
              <button
                type="button"
                className={lang === 'ar' ? 'selected' : ''}
                onClick={() => language('ar')}
              >
                العربية
              </button>
            </div>

            <button
              type="button"
              className="urgent-sos-primary"
              onClick={() => go(S.RECORD)}
            >
              {t('urgentSos.continue')}
            </button>
          </div>
        )}

        {step === S.RECORD && !sent && (
          <div className="urgent-sos-card">
            <div className="urgent-sos-step-label">
              {t('urgentSos.step', { current: 1, total: 3 })}
            </div>
            <h2>{t('urgentSos.recordTitle')}</h2>
            <p>{t('urgentSos.recordText')}</p>
            <Audio lang={lang} step={1} />

            {count > 0 && (
              <div className="urgent-sos-countdown">
                <strong>{t('urgentSos.countdownSpeak')}</strong>
                <span className="urgent-sos-countdown-number">{count}</span>
                <button
                  type="button"
                  className="urgent-sos-secondary urgent-sos-countdown-cancel"
                  onClick={cancelCountdown}
                >
                  {t('urgentSos.cancelCountdown')}
                </button>
              </div>
            )}

            {rec && (
              <div className="urgent-sos-recording active">
                <span className="urgent-sos-recording-dot" />
                <strong>
                  {`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`}
                </strong>
              </div>
            )}

            {!rec && !count && (
              <div className="urgent-sos-actions">
                <button
                  type="button"
                  className="urgent-sos-secondary"
                  onClick={previous}
                >
                  {t('urgentSos.previous')}
                </button>
                <button
                  type="button"
                  className="urgent-sos-primary"
                  onClick={start}
                >
                  <IconMic width={22} height={22} />
                  {t('urgentSos.start')}
                </button>
              </div>
            )}

            {rec && (
              <div className="urgent-sos-actions">
                <button
                  type="button"
                  className="urgent-sos-secondary"
                  onClick={previous}
                >
                  {t('urgentSos.previous')}
                </button>
                <button
                  type="button"
                  className="urgent-sos-danger"
                  onClick={stop}
                >
                  ⏹ {t('urgentSos.stop')}
                </button>
              </div>
            )}
          </div>
        )}

        {step === S.PREVIEW && !sent && (
          <div className="urgent-sos-card">
            <h2>{t('urgentSos.previewTitle')}</h2>
            <p>{t('urgentSos.previewText')}</p>
            <audio className="urgent-sos-preview" controls src={url} />
            <div className="urgent-sos-recorded-duration">
              {`${Math.floor(recordedDuration / 60)}:${String(recordedDuration % 60).padStart(2, '0')}`}
            </div>

            <div className="urgent-sos-actions">
              <button
                type="button"
                className="urgent-sos-secondary"
                onClick={previous}
              >
                {t('urgentSos.previous')}
              </button>
              <button
                type="button"
                className="urgent-sos-secondary"
                onClick={rerecord}
              >
                {t('urgentSos.rerecord')}
              </button>
              <button
                type="button"
                className="urgent-sos-primary"
                onClick={() => go(S.LOCATION)}
              >
                {t('urgentSos.continue')}
              </button>
            </div>
          </div>
        )}

        {step === S.LOCATION && !decision && !sent && (
          <div className="urgent-sos-card">
            <h2>{t('urgentSos.locationTitle')}</h2>
            <p>{t('urgentSos.locationText')}</p>

            <div className="urgent-sos-wilaya-field">
              <label htmlFor="urgent-sos-wilaya">
                {t('urgentSos.wilayaOptional')}
              </label>
              <div className="urgent-sos-wilaya-combobox">
                <input
                  id="urgent-sos-wilaya"
                  type="search"
                  value={search}
                  onChange={(event) => {
                    setSearch(event.target.value)
                    setWilaya(null)
                    setOpen(true)
                  }}
                  onFocus={() => setOpen(true)}
                  placeholder={t('urgentSos.wilayaSearchPlaceholder')}
                  autoComplete="off"
                  aria-expanded={open}
                />

                {search && (
                  <button
                    type="button"
                    className="urgent-sos-wilaya-reset"
                    onClick={() => {
                      setSearch('')
                      setWilaya(null)
                      setOpen(false)
                    }}
                    aria-label={t('common.close')}
                  >
                    ×
                  </button>
                )}

                <button
                  type="button"
                  className="urgent-sos-wilaya-chevron"
                  onClick={() => setOpen((value) => !value)}
                  aria-label={t('urgentSos.wilayaPlaceholder')}
                >
                  <Chevron />
                </button>

                {open && (
                  <div className="urgent-sos-wilaya-options" role="listbox">
                    {list.length ? (
                      list.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          className="urgent-sos-wilaya-option"
                          onClick={() => {
                            setWilaya(item.id)
                            setSearch(item.name)
                            setOpen(false)
                          }}
                        >
                          <span>{item.name}</span>
                        </button>
                      ))
                    ) : (
                      <div className="urgent-sos-wilaya-empty">
                        {t('urgentSos.wilayaHelp')}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <small>{t('urgentSos.wilayaHelp')}</small>
            </div>

            <Audio lang={lang} step={2} />

            {loc === 'success' && gps && (
              <div className="urgent-sos-location-status success">
                ✓ {t('urgentSos.locationDetected')}
                {acc ? ` · ±${acc} m` : ''}
              </div>
            )}

            {loc === 'outside' && (
              <div className="urgent-sos-location-status warning">
                ⚠️ {t('urgentSos.locationOutsideAlgeria')}
              </div>
            )}

            {loc === 'error' && (
              <div className="urgent-sos-location-status error">
                <strong>{t('urgentSos.locationNoGpsTitle')}</strong>
                <span>{error || t('urgentSos.locationError')}</span>
                <span>{t('urgentSos.locationSelectWilaya')}</span>
              </div>
            )}

            <div className="urgent-sos-actions urgent-sos-location-actions">
              <button
                type="button"
                className="urgent-sos-secondary"
                onClick={previous}
                disabled={busy}
              >
                {t('urgentSos.previous')}
              </button>
              <button
                type="button"
                className="urgent-sos-secondary"
                onClick={continueWithoutLocation}
                disabled={busy}
              >
                {t('urgentSos.noLocation')}
              </button>
              <button
                type="button"
                className="urgent-sos-primary"
                onClick={locate}
                disabled={busy}
              >
                {loc === 'locating'
                  ? t('urgentSos.locating')
                  : t('urgentSos.useLocation')}
              </button>
            </div>
          </div>
        )}

        {step === S.LOCATION && !sent && decision && (
          <div className="urgent-sos-validation-panel">
            <Audio lang={lang} step={5} />
            <p>{t('urgentSos.reviewText')}</p>
            {error && <p className="urgent-sos-error">{error}</p>}

            <div className="urgent-sos-location-summary">
              {gps
                ? `✓ ${t('urgentSos.locationDetected')}`
                : `✓ ${t('urgentSos.noLocation')}`}
              {wilaya && !gps ? ` · ${t('urgentSos.wilayaOptional')}` : ''}
            </div>

            {config.turnstile_enabled && (
              <div
                className="cf-turnstile urgent-sos-turnstile"
                data-sitekey={config.turnstile_site_key}
                data-callback="onUrgentSosTurnstileToken"
                ref={(element) => {
                  if (element) {
                    window.onUrgentSosTurnstileToken = (value) => {
                      window.__turnstileToken = value
                    }
                  }
                }}
              />
            )}

            <div className="urgent-sos-actions">
              <button
                type="button"
                className="urgent-sos-secondary"
                onClick={() => {
                  setDecision(false)
                  setError('')
                }}
                disabled={busy}
              >
                {t('urgentSos.previous')}
              </button>
              <button
                type="button"
                className="urgent-sos-primary"
                onClick={submit}
                disabled={busy}
              >
                🚨 {busy ? t('urgentSos.sending') : t('urgentSos.confirm')}
              </button>
            </div>
          </div>
        )}

        {sent && (
          <div className="urgent-sos-card urgent-sos-done-card">
            <div className="urgent-sos-final-badge">
              ✓ {t('urgentSos.doneTitle')}
            </div>
            <h2>{t('urgentSos.tokenTitle')}</h2>
            <p>{t('urgentSos.doneText')}</p>

            <div className="urgent-sos-token-box">
              <div className="urgent-sos-token-title">
                {t('urgentSos.accessTokenTitle')}
              </div>
              <p className="urgent-sos-token-warning">
                {t('urgentSos.accessTokenWarning')}
              </p>
              <div className="urgent-sos-token-row">
                <strong className="urgent-sos-token">{token}</strong>
                <button
                  type="button"
                  className="urgent-sos-copy-token"
                  onClick={copy}
                >
                  {copied
                    ? t('urgentSos.tokenCopied')
                    : t('urgentSos.copyToken')}
                </button>
              </div>
            </div>

            <div className="urgent-sos-final-warning">
              🔐 {t('urgentSos.finalPasswordWarning')}
            </div>
            <Audio lang={lang} step={6} />

            <div className="urgent-sos-actions">
              <Link to="/" className="urgent-sos-secondary">
                {t('urgentSos.backHome')}
              </Link>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
