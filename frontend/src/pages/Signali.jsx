import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api, apiUpload } from '../api'
import { translateApiError } from '../apiErrors'
import { compressPhoto, formatDate, isInAlgeria } from '../utils'
import PlaceAutocomplete from '../components/PlaceAutocomplete'
import SignaliAiNotice from '../components/SignaliAiNotice'
import { IconCamera, IconLocate, IconMapPin, IconMic, IconSwitchCamera, IconTrash, IconVideoCam } from '../icons'
import { SIGNALI_CATEGORIES, categoryEmoji, saveSignalementToken } from '../signali'
import '../urgent-sos-wizard-fixes.css'
import '../signali.css'

// Signali: an anonymous citizen report of a dangerous or broken spot in
// public space. Same wizard shell as UrgentSOS.jsx (stepper, cards,
// buttons) minus its guide audio, with four steps: where (GPS or a typed
// address -- one of the two is mandatory), a photo or a video (also
// mandatory), an optional description (category, text, voice note), then
// review and send. The server saves it at once; NSFW moderation and the
// transcription of the voice note / the video's soundtrack happen in the
// background (core.signalements) before it shows up on the map.

const S = { LOCATION: 0, MEDIA: 1, DESCRIPTION: 2, REVIEW: 3 }
const MAX_PHOTOS = 3
const MAX_VIDEO_SECONDS = 20
const MAX_VOICE_SECONDS = 120
const MAX_VIDEO_BYTES = 10 * 1024 * 1024

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

function pickMime(candidates) {
  return candidates.find((x) => window.MediaRecorder?.isTypeSupported?.(x)) || ''
}

function extFor(type) {
  return type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'
}

// Small Leaflet map with a draggable pin: GPS is rarely exactly on the
// broken pole, so the reporter can nudge it (drag, or tap the map). With
// no position yet (manual entry), it starts on `center` and the first tap
// drops the pin -- a map-based alternative to typing an address.
function PinMap({ position, center, onMove }) {
  const { t } = useTranslation()
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const markerRef = useRef(null)
  const onMoveRef = useRef(onMove)
  useEffect(() => {
    onMoveRef.current = onMove
  }, [onMove])
  const initialRef = useRef({ position, center })

  useEffect(() => {
    const map = L.map(elRef.current, {
      attributionControl: false,
      zoomControl: true,
      gestureHandling: true,
      gestureHandlingOptions: { text: { touch: t('map.gestureTouch'), scroll: t('map.gestureScroll'), scrollMac: t('map.gestureScrollMac') } },
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map)
    const icon = L.divIcon({ className: 'signali-pin', html: '<span>⚠️</span>', iconSize: [36, 36], iconAnchor: [18, 34] })
    const place = (latlng) => {
      if (!markerRef.current) {
        markerRef.current = L.marker(latlng, { icon, draggable: true }).addTo(map)
        markerRef.current.on('dragend', () => {
          const p = markerRef.current.getLatLng()
          onMoveRef.current({ latitude: p.lat, longitude: p.lng })
        })
      } else {
        markerRef.current.setLatLng(latlng)
      }
    }
    map.on('click', (e) => {
      place(e.latlng)
      onMoveRef.current({ latitude: e.latlng.lat, longitude: e.latlng.lng })
    })
    const start = initialRef.current
    if (start.position) {
      place([start.position.latitude, start.position.longitude])
      map.setView([start.position.latitude, start.position.longitude], 17)
    } else {
      map.setView([start.center.latitude, start.center.longitude], start.center.zoom)
    }
    mapRef.current = map
    mapRef.current._signaliPlace = place
    return () => {
      markerRef.current = null
      map.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follows position changes made outside the map (typed coordinates, an
  // address suggestion, GPS) and center changes (a newly picked wilaya).
  const lat = position?.latitude
  const lon = position?.longitude
  useEffect(() => {
    const map = mapRef.current
    if (!map || lat == null) return
    const current = markerRef.current?.getLatLng()
    if (!current || current.lat !== lat || current.lng !== lon) {
      map._signaliPlace([lat, lon])
      map.setView([lat, lon], Math.max(map.getZoom(), 16))
    }
  }, [lat, lon])
  const cLat = center?.latitude
  const cLon = center?.longitude
  const cZoom = center?.zoom
  useEffect(() => {
    const map = mapRef.current
    if (!map || cLat == null || markerRef.current) return
    map.setView([cLat, cLon], cZoom)
  }, [cLat, cLon, cZoom])

  return <div ref={elRef} className="signali-pin-map" />
}

// "36.7525, 3.0420" (or with a space / semicolon) -> {latitude, longitude}
function parseCoords(text) {
  const m = String(text).trim().match(/^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/)
  if (!m) return null
  const latitude = parseFloat(m[1].replace(',', '.'))
  const longitude = parseFloat(m[2].replace(',', '.'))
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null
}

export default function Signali() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { config, wilayas, refreshConfig } = useApp()

  const [step, setStep] = useState(S.LOCATION)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // --- location ---
  const [locMode, setLocMode] = useState(null) // null | 'gps' | 'manual'
  const [locStatus, setLocStatus] = useState('idle') // idle | locating | success | error
  const [coords, setCoords] = useState(null)
  const [accuracy, setAccuracy] = useState(null)
  const [address, setAddress] = useState('')
  const [wilaya, setWilaya] = useState('')
  const [commune, setCommune] = useState('')
  const [nearby, setNearby] = useState([])
  const [confirmedId, setConfirmedId] = useState(null)
  const [coordsText, setCoordsText] = useState('')
  const [adminNote, setAdminNote] = useState(false)

  // --- media ---
  const [photos, setPhotos] = useState([]) // [{file, url}]
  const [video, setVideo] = useState(null) // {blob, url}
  const [camera, setCamera] = useState(null) // live MediaStream while filming
  const [facing, setFacing] = useState('environment')
  const [filming, setFilming] = useState(false)
  const [videoSec, setVideoSec] = useState(0)

  // --- description ---
  const [category, setCategory] = useState('other')
  const [description, setDescription] = useState('')
  const [voice, setVoice] = useState(null) // {blob, url}
  const [recordingVoice, setRecordingVoice] = useState(false)
  const [voiceSec, setVoiceSec] = useState(0)

  const recorderRef = useRef(null)
  const timerRef = useRef(null)
  const discardRef = useRef(false)
  const liveVideoRef = useRef(null)
  const cameraRef = useRef(null)
  const urlsRef = useRef([])

  const track = (url) => {
    urlsRef.current.push(url)
    return url
  }

  useEffect(
    () => () => {
      clearInterval(timerRef.current)
      const r = recorderRef.current
      if (r && r.state !== 'inactive') {
        discardRef.current = true
        try {
          r.stop()
        } catch {
          /* already stopped */
        }
      }
      cameraRef.current?.getTracks().forEach((x) => x.stop())
      urlsRef.current.forEach((u) => URL.revokeObjectURL(u))
    },
    []
  )

  useEffect(() => {
    cameraRef.current = camera
    if (liveVideoRef.current) liveVideoRef.current.srcObject = camera
  }, [camera])

  // "Already reported here?" -- looked up whenever the pin moves.
  useEffect(() => {
    if (!coords) return
    let cancelled = false
    const id = setTimeout(async () => {
      try {
        const hits = await api(`/signalements/nearby/?lat=${coords.latitude}&lon=${coords.longitude}`)
        if (!cancelled) setNearby(hits || [])
      } catch {
        if (!cancelled) setNearby([])
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(id)
    }
  }, [coords])

  const go = (n) => {
    setError('')
    setStep(n)
    window.scrollTo(0, 0)
  }

  const prefillWilaya = async ({ latitude, longitude }) => {
    try {
      const w = await api(`/wilayas/nearest/?lat=${latitude}&lon=${longitude}`)
      if (w?.id) setWilaya(String(w.id))
    } catch {
      /* the reporter can still pick it by hand */
    }
  }

  const locate = async () => {
    setError('')
    setLocMode('gps')
    if (!navigator.geolocation) {
      setLocStatus('error')
      setError(t('signali.locationUnsupported'))
      return
    }
    setLocStatus('locating')
    const get = (o) => new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, o))
    try {
      let p
      try {
        p = await get({ enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 })
      } catch {
        p = await get({ enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 })
      }
      const { latitude, longitude, accuracy: acc } = p.coords
      if (!isInAlgeria(latitude, longitude)) {
        if (config.is_admin) {
          // An admin testing from abroad: never pin outside Algeria (the
          // server drops such coordinates too) -- fall back to a manual
          // entry pre-filled with Alger, like the admin voice SOS.
          setLocMode('manual')
          setLocStatus('idle')
          setCoords(null)
          setAddress(t('signali.adminOutsideAddress'))
          setWilaya(String(wilayas.find((w) => w.code === '16')?.id || ''))
          setAdminNote(true)
          return
        }
        setLocStatus('error')
        setError(t('signali.locationOutsideAlgeria'))
        return
      }
      setCoords({ latitude, longitude })
      setAccuracy(Number.isFinite(acc) ? Math.round(acc) : null)
      setLocStatus('success')
      prefillWilaya({ latitude, longitude })
    } catch (e) {
      setLocStatus('error')
      setError(e?.code === 1 ? t('signali.locationDenied') : t('signali.locationError'))
    }
  }

  const useManual = () => {
    setError('')
    setAdminNote(false)
    setLocMode('manual')
    setLocStatus('idle')
    setCoords(null)
    setAccuracy(null)
  }

  const onSelectPlace = ({ lat, lon }) => {
    if (!isInAlgeria(lat, lon)) return
    const next = { latitude: lat, longitude: lon }
    setCoords(next)
    prefillWilaya(next)
  }

  // Manual entry: a pin dropped on the map (or typed GPS coordinates), or
  // at least an address with its wilaya -- that one lands in the map's
  // "no location" bubble.
  const locationOk = locMode === 'gps' ? !!coords : locMode === 'manual' ? !!coords || !!(address.trim() && wilaya) : false

  const applyTypedCoords = () => {
    const c = parseCoords(coordsText)
    if (!c) return setError(t('signali.coordsInvalid'))
    if (!isInAlgeria(c.latitude, c.longitude)) return setError(t('signali.coordsOutsideAlgeria'))
    setError('')
    setCoords(c)
    prefillWilaya(c)
  }

  const selectedWilaya = wilayas.find((w) => String(w.id) === String(wilaya))
  const manualCenter = selectedWilaya?.centroid_latitude
    ? { latitude: selectedWilaya.centroid_latitude, longitude: selectedWilaya.centroid_longitude, zoom: 11 }
    : { latitude: 34.5, longitude: 3, zoom: 5 }

  const confirmExisting = async (id) => {
    setBusy(true)
    setError('')
    try {
      await api(`/signalements/${id}/confirm/`, { method: 'POST' })
      setConfirmedId(id)
    } catch (e) {
      setError(translateApiError(e, t))
    } finally {
      setBusy(false)
    }
  }

  // --- photos ---
  const addPhotos = async (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    const room = MAX_PHOTOS - photos.length
    const next = []
    for (const file of files.slice(0, room)) {
      const compressed = await compressPhoto(file)
      next.push({ file: compressed, url: track(URL.createObjectURL(compressed)) })
    }
    setPhotos((prev) => [...prev, ...next].slice(0, MAX_PHOTOS))
  }
  const removePhoto = (idx) => setPhotos((prev) => prev.filter((_, i) => i !== idx))

  // --- video: live camera with the soundtrack, so the reporter can talk ---
  const openCamera = async (mode = facing) => {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: mode, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true })
      setCamera((prev) => {
        prev?.getTracks().forEach((x) => x.stop())
        return stream
      })
      return true
    } catch (e) {
      setError(e?.name === 'NotAllowedError' ? t('signali.cameraDenied') : t('signali.cameraUnavailable'))
      return true
    }
  }
  const switchCamera = async () => {
    const next = facing === 'environment' ? 'user' : 'environment'
    setFacing(next)
    await openCamera(next)
  }
  const closeCamera = () => {
    camera?.getTracks().forEach((x) => x.stop())
    setCamera(null)
  }

  const stopRecorder = () => {
    clearInterval(timerRef.current)
    const r = recorderRef.current
    if (r && r.state !== 'inactive') r.stop()
  }

  const startFilming = () => {
    if (!camera) return
    const mime = pickMime(['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'])
    // ~1.5 Mbit/s keeps a 20 s clip well under the server's 10 MB cap.
    const r = new MediaRecorder(camera, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1500000 })
    const chunks = []
    discardRef.current = false
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    r.onstop = () => {
      setFilming(false)
      camera.getTracks().forEach((x) => x.stop())
      setCamera(null)
      if (discardRef.current) return
      const blob = new Blob(chunks, { type: r.mimeType || mime || 'video/webm' })
      if (!blob.size) return setError(t('signali.recordingError'))
      if (blob.size > MAX_VIDEO_BYTES) return setError(t('signali.videoTooLarge'))
      setVideo({ blob, url: track(URL.createObjectURL(blob)) })
    }
    recorderRef.current = r
    r.start(250)
    setFilming(true)
    setVideoSec(0)
    let elapsed = 0
    timerRef.current = setInterval(() => {
      elapsed += 1
      setVideoSec(elapsed)
      if (elapsed >= MAX_VIDEO_SECONDS) stopRecorder()
    }, 1000)
  }

  // Fallback for browsers without MediaRecorder: the phone's own camera app.
  const pickVideoFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_VIDEO_BYTES) return setError(t('signali.videoTooLarge'))
    const url = track(URL.createObjectURL(file))
    const probe = document.createElement('video')
    probe.preload = 'metadata'
    probe.onloadedmetadata = () => {
      if (probe.duration > MAX_VIDEO_SECONDS + 1) return setError(t('signali.videoTooLong', { max: MAX_VIDEO_SECONDS }))
      setError('')
      setVideo({ blob: file, url })
    }
    probe.onerror = () => setVideo({ blob: file, url })
    probe.src = url
  }

  const startVideo = async () => {
    const opened = await openCamera()
    if (!opened) document.getElementById('signali-video-file')?.click()
  }

  const mediaOk = photos.length > 0 || !!video

  // --- voice note ---
  const startVoice = async () => {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return setError(t('signali.microphoneUnsupported'))
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = pickMime(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'])
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      const chunks = []
      discardRef.current = false
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      r.onstop = () => {
        stream.getTracks().forEach((x) => x.stop())
        setRecordingVoice(false)
        if (discardRef.current) return
        const blob = new Blob(chunks, { type: r.mimeType || mime || 'audio/webm' })
        if (!blob.size) return setError(t('signali.recordingError'))
        setVoice({ blob, url: track(URL.createObjectURL(blob)) })
      }
      recorderRef.current = r
      r.start(250)
      setRecordingVoice(true)
      setVoiceSec(0)
      let elapsed = 0
      timerRef.current = setInterval(() => {
        elapsed += 1
        setVoiceSec(elapsed)
        if (elapsed >= MAX_VOICE_SECONDS) stopRecorder()
      }, 1000)
    } catch (e) {
      setError(e?.name === 'NotAllowedError' ? t('signali.microphoneDenied') : t('signali.microphoneUnavailable'))
    }
  }

  // --- submit ---
  const submit = async () => {
    if (!locationOk || !mediaOk) return
    if (config.turnstile_enabled && !(window.__turnstileToken || '')) return setError(t('apiErrors.captchaRequired'))
    setBusy(true)
    setError('')
    try {
      const f = new FormData()
      const fields = {
        category,
        wilaya,
        commune: commune.trim(),
        address: address.trim(),
        latitude: coords ? coords.latitude.toFixed(6) : '',
        longitude: coords ? coords.longitude.toFixed(6) : '',
        position_source: locMode === 'gps' ? 'gps' : 'manual',
        description: description.trim(),
        turnstile_token: window.__turnstileToken || '',
      }
      Object.entries(fields).forEach(([k, v]) => v !== '' && v != null && f.append(k, v))
      photos.forEach((p, i) => f.append('photos', p.file, p.file.name || `photo-${i + 1}.jpg`))
      if (video) f.append('video_file', new File([video.blob], `signali-video.${extFor(video.blob.type || '')}`, { type: video.blob.type || 'video/webm' }))
      if (voice) f.append('voice_file', new File([voice.blob], `signali-voice.${extFor(voice.blob.type || '')}`, { type: voice.blob.type || 'audio/webm' }))
      const created = await apiUpload('/signalements/', f)
      if (created?.id && created.access_token) saveSignalementToken(created.id, created.access_token)
      Promise.resolve(refreshConfig()).catch(() => {})
      navigate(`/signalements/${created.id}`, { state: { justCreated: true } })
    } catch (e) {
      setError(translateApiError(e, t))
    } finally {
      setBusy(false)
    }
  }

  const wilayaName = selectedWilaya?.name || ''
  const steps = [t('signali.stepLocation'), t('signali.stepMedia'), t('signali.stepDescription'), t('signali.stepReview')]

  // Same rule as the server (views.signali_allowed): Algeria, or an admin.
  if (config.signali_available === false) {
    return (
      <section className="urgent-sos-page signali-page">
        <div className="urgent-sos-shell">
          <div className="urgent-sos-card">
            <h2>{t('signali.title')}</h2>
            <p>{t('signali.algeriaOnly')}</p>
            <div className="urgent-sos-actions">
              <Link to="/signalements" className="urgent-sos-primary">{t('signali.viewOnMap')}</Link>
            </div>
          </div>
        </div>
      </section>
    )
  }

  if (confirmedId) {
    return (
      <section className="urgent-sos-page signali-page">
        <div className="urgent-sos-shell">
          <div className="urgent-sos-card urgent-sos-done-card">
            <div className="urgent-sos-final-badge">✓ {t('signali.confirmedTitle')}</div>
            <p>{t('signali.confirmedText')}</p>
            <div className="urgent-sos-actions">
              <Link to={`/signalements/${confirmedId}`} className="urgent-sos-primary">{t('signali.viewOnMap')}</Link>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="urgent-sos-page signali-page">
      <div className="urgent-sos-shell">
        <div className="urgent-sos-kicker">📣 {t('signali.kicker')}</div>
        <div className="urgent-sos-hero">
          <div className="urgent-sos-icon"><IconCamera width={32} height={32} /></div>
          <div>
            <h1>{t('signali.title')}</h1>
            <p>{t('signali.subtitle')}</p>
          </div>
        </div>
        <div className="urgent-sos-stepper">
          {steps.map((x, i) => (
            <div key={x} className={i <= step ? 'done' : ''} data-current={i === step}>
              <span>{i + 1}</span>
              <small>{x}</small>
            </div>
          ))}
        </div>
        <div className="urgent-sos-progress">
          {steps.map((x, i) => <span key={x} className={i <= step ? 'active' : ''} />)}
        </div>

        {step === S.LOCATION && (
          <div className="urgent-sos-card">
            <h2>{t('signali.locationTitle')}</h2>
            <p>{t('signali.locationText')}</p>
            <div className="signali-choice-row">
              <button type="button" className={`signali-choice${locMode === 'gps' ? ' selected' : ''}`} onClick={locate} disabled={locStatus === 'locating'}>
                <IconLocate width={22} height={22} />
                <span>{locStatus === 'locating' ? t('signali.locating') : t('signali.useLocation')}</span>
              </button>
              <button type="button" className={`signali-choice${locMode === 'manual' ? ' selected' : ''}`} onClick={useManual}>
                <IconMapPin width={22} height={22} />
                <span>{t('signali.typeAddress')}</span>
              </button>
            </div>

            {locMode === 'gps' && locStatus === 'success' && coords && (
              <div className="urgent-sos-location-status success">
                ✓ {t('signali.locationDetected')}{accuracy ? ` · ±${accuracy} m` : ''}
              </div>
            )}
            {locStatus === 'error' && (
              <div className="urgent-sos-location-status error">
                <span>{error || t('signali.locationError')}</span>
                <button type="button" className="signali-link" onClick={useManual}>{t('signali.typeAddressInstead')}</button>
              </div>
            )}

            {adminNote && <div className="urgent-sos-location-status warning">⚠️ {t('signali.adminOutsideNote')}</div>}

            {locMode === 'manual' && (
              <div className="signali-fields">
                <label htmlFor="signali-wilaya">{t('signali.wilayaLabel')}</label>
                <select id="signali-wilaya" value={wilaya} onChange={(e) => setWilaya(e.target.value)}>
                  <option value="">{t('signali.wilayaPlaceholder')}</option>
                  {wilayas.map((w) => (
                    <option key={w.id} value={w.id}>{w.code} - {w.name}</option>
                  ))}
                </select>
                <label htmlFor="signali-address">{t('signali.addressLabel')}</label>
                <PlaceAutocomplete
                  id="signali-address"
                  value={address}
                  onChange={setAddress}
                  onSelectPlace={onSelectPlace}
                  placeholder={t('signali.addressPlaceholder')}
                  countryCode="dz"
                />
                <label htmlFor="signali-commune">{t('signali.communeLabel')} <small>({t('common.optional')})</small></label>
                <input id="signali-commune" type="text" value={commune} onChange={(e) => setCommune(e.target.value)} />
                <span className="signali-fields-title">{t('signali.pickOnMap')}</span>
                <PinMap position={coords} center={manualCenter} onMove={(c) => (setCoords(c), prefillWilaya(c))} />
                <small className="signali-hint">{coords ? t('signali.dragPinHint') : t('signali.tapMapHint')}</small>
                <label htmlFor="signali-coords">{t('signali.coordsLabel')} <small>({t('common.optional')})</small></label>
                <div className="signali-coords-row">
                  <input
                    id="signali-coords"
                    type="text"
                    inputMode="decimal"
                    value={coordsText}
                    onChange={(e) => setCoordsText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyTypedCoords())}
                    placeholder="36.7525, 3.0420"
                  />
                  <button type="button" className="urgent-sos-secondary" onClick={applyTypedCoords}>{t('signali.placeCoords')}</button>
                </div>
                {!coords && address.trim() && wilaya && <small className="signali-hint">{t('signali.noPinHint')}</small>}
              </div>
            )}

            {locMode === 'gps' && coords && (
              <>
                <PinMap position={coords} onMove={setCoords} />
                <small className="signali-hint">{t('signali.dragPinHint')}</small>
              </>
            )}

            {coords && nearby.length > 0 && (
              <div className="signali-nearby">
                <strong>{t('signali.nearbyTitle')}</strong>
                <p>{t('signali.nearbyText')}</p>
                {nearby.map((s) => {
                  const photo = s.photos.find((p) => p.image)?.image
                  return (
                    <div className="signali-nearby-item" key={s.id}>
                      {photo ? <img src={photo} alt="" /> : <span className="signali-nearby-emoji">{categoryEmoji(s.category)}</span>}
                      <div>
                        <b>{t(`signali.categories.${s.category}`)}</b>
                        <small>{formatDate(s.created_at, i18n.language)} · {t('signali.confirmationsCount', { count: s.confirmations_count + 1 })}</small>
                      </div>
                      <button type="button" className="urgent-sos-secondary" onClick={() => confirmExisting(s.id)} disabled={busy}>
                        {t('signali.sameProblem')}
                      </button>
                    </div>
                  )
                })}
              </div>
            )}

            {error && locStatus !== 'error' && <p className="urgent-sos-error">{error}</p>}
            <div className="urgent-sos-actions">
              <Link to="/signalements" className="urgent-sos-secondary">{t('signali.cancel')}</Link>
              <button type="button" className="urgent-sos-primary" onClick={() => go(S.MEDIA)} disabled={!locationOk}>
                {coords && nearby.length ? t('signali.otherProblem') : t('signali.continue')}
              </button>
            </div>
            {!locationOk && <small className="signali-hint">{t('signali.locationRequired')}</small>}
          </div>
        )}

        {step === S.MEDIA && (
          <div className="urgent-sos-card">
            <h2>{t('signali.mediaTitle')}</h2>
            <p>{t('signali.mediaText')}</p>

            {camera ? (
              <div className="signali-camera">
                <video ref={liveVideoRef} autoPlay muted playsInline />
                {filming && (
                  <div className="urgent-sos-recording active signali-camera-timer">
                    <span className="urgent-sos-recording-dot" />
                    <strong>{mmss(videoSec)} / {mmss(MAX_VIDEO_SECONDS)}</strong>
                  </div>
                )}
                <div className="signali-camera-actions">
                  {!filming && (
                    <button type="button" className="urgent-sos-secondary" onClick={closeCamera}>{t('common.cancel')}</button>
                  )}
                  {!filming && (
                    <button type="button" className="signali-icon-btn" onClick={switchCamera} aria-label={t('signali.switchCamera')}>
                      <IconSwitchCamera width={20} height={20} />
                    </button>
                  )}
                  {filming ? (
                    <button type="button" className="urgent-sos-danger" onClick={stopRecorder}>⏹ {t('signali.stop')}</button>
                  ) : (
                    <button type="button" className="urgent-sos-primary" onClick={startFilming}>● {t('signali.record')}</button>
                  )}
                </div>
                <small className="signali-hint">{t('signali.videoTalkHint')}</small>
              </div>
            ) : (
              <>
                <div className="signali-choice-row">
                  <label className={`signali-choice${photos.length >= MAX_PHOTOS ? ' disabled' : ''}`}>
                    <IconCamera width={22} height={22} />
                    <span>{t('signali.takePhoto')}</span>
                    <small>{photos.length}/{MAX_PHOTOS}</small>
                    <input type="file" accept="image/*" capture="environment" onChange={addPhotos} hidden disabled={photos.length >= MAX_PHOTOS} />
                  </label>
                  <button type="button" className="signali-choice" onClick={startVideo} disabled={!!video}>
                    <IconVideoCam width={22} height={22} />
                    <span>{t('signali.recordVideo')}</span>
                    <small>{t('signali.videoMax', { max: MAX_VIDEO_SECONDS })}</small>
                  </button>
                  <input id="signali-video-file" type="file" accept="video/*" capture="environment" onChange={pickVideoFile} hidden />
                </div>
                <label className="signali-link signali-gallery-link">
                  {t('signali.fromGallery')}
                  <input type="file" accept="image/*" multiple onChange={addPhotos} hidden disabled={photos.length >= MAX_PHOTOS} />
                </label>

                {(photos.length > 0 || video) && (
                  <div className="signali-thumbs">
                    {photos.map((p, i) => (
                      <div className="signali-thumb" key={p.url}>
                        <img src={p.url} alt={t('common.photoAlt')} />
                        <button type="button" onClick={() => removePhoto(i)} aria-label={t('common.delete')}><IconTrash width={14} height={14} /></button>
                      </div>
                    ))}
                    {video && (
                      <div className="signali-thumb signali-thumb-video">
                        <video src={video.url} controls playsInline />
                        <button type="button" onClick={() => setVideo(null)} aria-label={t('common.delete')}><IconTrash width={14} height={14} /></button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {error && <p className="urgent-sos-error">{error}</p>}
            {!camera && (
              <div className="urgent-sos-actions">
                <button type="button" className="urgent-sos-secondary" onClick={() => go(S.LOCATION)}>{t('signali.previous')}</button>
                <button type="button" className="urgent-sos-primary" onClick={() => go(S.DESCRIPTION)} disabled={!mediaOk}>{t('signali.continue')}</button>
              </div>
            )}
            {!mediaOk && !camera && <small className="signali-hint">{t('signali.mediaRequired')}</small>}
          </div>
        )}

        {step === S.DESCRIPTION && (
          <div className="urgent-sos-card">
            <h2>{t('signali.descriptionTitle')}</h2>
            <p>{t('signali.descriptionText')}</p>
            <div className="signali-categories" role="radiogroup" aria-label={t('signali.categoryLabel')}>
              {SIGNALI_CATEGORIES.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={category === c} className={category === c ? 'selected' : ''} onClick={() => setCategory(c)}>
                  <span aria-hidden="true">{categoryEmoji(c)}</span> {t(`signali.categories.${c}`)}
                </button>
              ))}
            </div>
            {category === 'other' && <small className="signali-hint">{t('signali.otherCategoryHint')}</small>}

            <label htmlFor="signali-description" className="signali-label">{t('signali.textLabel')} <small>({t('common.optional')})</small></label>
            <textarea id="signali-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('signali.textPlaceholder')} maxLength={2000} />

            <div className="signali-label">{t('signali.voiceLabel')} <small>({t('common.optional')})</small></div>
            {recordingVoice ? (
              <div className="urgent-sos-actions">
                <div className="urgent-sos-recording active">
                  <IconMic width={20} height={20} />
                  <span className="urgent-sos-recording-dot" />
                  <strong>{mmss(voiceSec)}</strong>
                </div>
                <button type="button" className="urgent-sos-danger" onClick={stopRecorder}>⏹ {t('signali.stop')}</button>
              </div>
            ) : voice ? (
              <div className="signali-voice">
                <audio src={voice.url} controls />
                <button type="button" className="urgent-sos-secondary" onClick={() => setVoice(null)}>{t('signali.rerecord')}</button>
              </div>
            ) : (
              <button type="button" className="signali-choice signali-choice-wide" onClick={startVoice}>
                <IconMic width={22} height={22} />
                <span>{t('signali.recordVoice')}</span>
              </button>
            )}
            <small className="signali-hint">{t('signali.voiceHint')}</small>

            {error && <p className="urgent-sos-error">{error}</p>}
            <div className="urgent-sos-actions">
              <button type="button" className="urgent-sos-secondary" onClick={() => go(S.MEDIA)} disabled={recordingVoice}>{t('signali.previous')}</button>
              <button type="button" className="urgent-sos-primary" onClick={() => go(S.REVIEW)} disabled={recordingVoice}>{t('signali.continue')}</button>
            </div>
          </div>
        )}

        {step === S.REVIEW && (
          <div className="urgent-sos-validation-panel">
            <h2>{t('signali.reviewTitle')}</h2>
            <ul className="signali-summary">
              <li>
                <span>📍</span>
                <div>
                  <b>{address.trim() || (locMode === 'gps' ? t('signali.gpsPosition') : '')}</b>
                  <small>{[commune.trim(), wilayaName].filter(Boolean).join(', ')}{accuracy && locMode === 'gps' ? ` · ±${accuracy} m` : ''}</small>
                </div>
              </li>
              <li>
                <span>{categoryEmoji(category)}</span>
                <div><b>{t(`signali.categories.${category}`)}</b></div>
              </li>
              <li>
                <span>🖼️</span>
                <div>
                  <b>{[photos.length ? t('signali.photosCount', { count: photos.length }) : '', video ? t('signali.videoIncluded') : ''].filter(Boolean).join(' + ')}</b>
                </div>
              </li>
              {(description.trim() || voice) && (
                <li>
                  <span>💬</span>
                  <div>
                    {description.trim() && <b>{description.trim()}</b>}
                    {voice && <small>🎙️ {t('signali.voiceIncluded')}</small>}
                  </div>
                </li>
              )}
            </ul>
            <SignaliAiNotice />
            <div className="urgent-sos-location-confirmation confirmed" role="status">
              <strong>🔒 {t('signali.anonymousTitle')}</strong>
              <span>{t('signali.anonymousText')}</span>
            </div>
            {config.turnstile_enabled && (
              <div
                className="cf-turnstile urgent-sos-turnstile"
                data-sitekey={config.turnstile_site_key}
                data-callback="onSignaliTurnstileToken"
                ref={(el) => {
                  if (el) window.onSignaliTurnstileToken = (v) => (window.__turnstileToken = v)
                }}
              />
            )}
            {error && <p className="urgent-sos-error">{error}</p>}
            <div className="urgent-sos-actions">
              <button type="button" className="urgent-sos-secondary" onClick={() => go(S.DESCRIPTION)} disabled={busy}>{t('signali.previous')}</button>
              <button type="button" className="urgent-sos-primary" onClick={submit} disabled={busy}>
                📣 {busy ? t('signali.sending') : t('signali.send')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
