import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { addBaseLayer } from '../mapBase'
import { useApp } from '../context/AppContext'
import { api, apiUpload } from '../api'
import { translateApiError } from '../apiErrors'
import { compressPhoto, formatDate, getCurrentPosition, isInAlgeria } from '../utils'
import PlaceAutocomplete from '../components/PlaceAutocomplete'
import { IconArrowLeft, IconCamera, IconClose, IconExpand, IconGallery, IconLocate, IconMic, IconSwitchCamera, IconVideoCam, IconVideoUpload } from '../icons'
import { saveSignalementToken, signalIconSvg } from '../signali'
import CategoryIcon from '../components/CategoryIcon'
import { detectWilaya, reverseGeocode } from '../wilayaGeo'
import CategoryPicker from '../components/CategoryPicker'
import '../urgent-sos-wizard-fixes.css'
import '../signali.css'
import '../signali-wizard.css'

// Signali: an anonymous citizen report of a dangerous or broken spot in
// public space. Same wizard shell as UrgentSOS.jsx (stepper, cards,
// buttons) minus its guide audio, with four steps: where (GPS or a typed
// address -- one of the two is mandatory), a photo or a video (also
// mandatory), an optional description (category, text, voice note), then
// review and send. The server saves it at once; NSFW moderation and the
// transcription of the voice note / the video's soundtrack happen in the
// background (core.signalements) before it shows up on the map.

const MAX_PHOTOS = 3
const MAX_VIDEO_SECONDS = 20
const MAX_VOICE_SECONDS = 120
const MAX_VIDEO_MB = 10 // = core.media_validation.MAX_VIDEO_SIZE_MB
const MAX_VIDEO_BYTES = MAX_VIDEO_MB * 1024 * 1024

const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

function pickMime(candidates) {
  return candidates.find((x) => window.MediaRecorder?.isTypeSupported?.(x)) || ''
}

function extFor(type) {
  return type.includes('mp4') ? 'mp4' : type.includes('ogg') ? 'ogg' : 'webm'
}

// One-hand location picker: the pin stays in the middle of the map and
// the map moves under it (one finger, no "use two fingers" lock), like the
// ride-hailing apps -- no small pin to grab and drag. A tap slides the
// tapped spot under the pin; pinch / double-tap / +- zoom around the pin,
// so zooming never moves the chosen spot. With no position yet (manual
// entry), the pin is faded until the map is first moved or tapped.
function PinMap({ position, center, onMove }) {
  const { t } = useTranslation()
  const elRef = useRef(null)
  const mapRef = useRef(null)
  const pinRef = useRef(null)
  const quietRef = useRef(false) // a move made by the code, not the finger (see _quietView)
  const onMoveRef = useRef(onMove)
  useEffect(() => {
    onMoveRef.current = onMove
  }, [onMove])
  const initialRef = useRef({ position, center })
  const [placed, setPlaced] = useState(!!position)

  useEffect(() => {
    const map = L.map(elRef.current, {
      attributionControl: false,
      zoomControl: true,
      touchZoom: 'center',
      scrollWheelZoom: 'center',
      doubleClickZoom: 'center',
      bounceAtZoomLimits: false,
    })
    addBaseLayer(map)
    const lift = (up) => pinRef.current?.classList.toggle('is-moving', up)
    map.on('movestart', () => !quietRef.current && lift(true))
    map.on('moveend', () => {
      lift(false)
      if (quietRef.current) return
      const c = map.getCenter()
      setPlaced(true)
      onMoveRef.current({ latitude: c.lat, longitude: c.lng })
    })
    map.on('click', (e) => map.panTo(e.latlng, { animate: true, duration: 0.3 }))
    // Code-made moves: instant, so their moveend has fired by the time the
    // flag drops.
    map._quietView = (latlng, zoom) => {
      quietRef.current = true
      map.setView(latlng, zoom, { animate: false })
      quietRef.current = false
    }
    const start = initialRef.current
    if (start.position) map._quietView([start.position.latitude, start.position.longitude], 17)
    else map._quietView([start.center.latitude, start.center.longitude], start.center.zoom)
    mapRef.current = map
    return () => map.remove()
  }, [])

  // Follows position changes made outside the map (an address suggestion,
  // GPS) and center changes (a newly picked wilaya) without reporting them
  // back as a move.
  const lat = position?.latitude
  const lon = position?.longitude
  useEffect(() => {
    const map = mapRef.current
    if (!map || lat == null) return
    setPlaced(true)
    const c = map.getCenter()
    if (Math.abs(c.lat - lat) > 1e-6 || Math.abs(c.lng - lon) > 1e-6) {
      map._quietView([lat, lon], Math.max(map.getZoom(), 16))
    }
  }, [lat, lon])
  const cLat = center?.latitude
  const cLon = center?.longitude
  const cZoom = center?.zoom
  useEffect(() => {
    const map = mapRef.current
    if (!map || cLat == null || lat != null) return
    map._quietView([cLat, cLon], cZoom)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cLat, cLon, cZoom])

  // Same buttons as the other maps: fullscreen and "center on me".
  const frameRef = useRef(null)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => mapRef.current?.invalidateSize())
    return () => cancelAnimationFrame(id)
  }, [fullscreen])
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frameRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const enterFullscreen = () => {
    setFullscreen(true)
    frameRef.current?.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
  }
  const exitFullscreen = () => {
    if (document.fullscreenElement === frameRef.current) document.exitFullscreen?.()?.catch(() => {})
    setFullscreen(false)
  }
  const recenterOnMe = async () => {
    const pos = await getCurrentPosition({ maximumAge: 30000, timeout: 5000, enableHighAccuracy: true })
    if (pos) mapRef.current?.setView(pos, 17)
  }

  return (
    <div ref={frameRef} className={`map-frame signali-pin-frame${fullscreen ? ' map-frame-fullscreen' : ''}`}>
      <div ref={elRef} className="signali-pin-map" />
      <div ref={pinRef} className={`signali-pin-center${placed ? '' : ' is-unset'}`} aria-hidden="true">
        <span className="signali-pin-badge" dangerouslySetInnerHTML={{ __html: signalIconSvg(18) }} />
        <i />
      </div>
      {fullscreen ? (
        <button type="button" className="exit-fullscreen-btn" onClick={exitFullscreen} aria-label={t('map.exitFullscreen')} title={t('map.exitFullscreen')}>
          <IconClose width={20} height={20} />
        </button>
      ) : (
        <button type="button" className="expand-btn" onClick={enterFullscreen} aria-label={t('map.viewFullscreen')} title={t('map.viewFullscreen')}>
          <IconExpand width={18} height={18} />
        </button>
      )}
      <button type="button" className="locate-btn" onClick={recenterOnMe} aria-label={t('map.recenterOnMe')} title={t('map.recenterOnMe')}>
        <IconLocate width={18} height={18} />
      </button>
    </div>
  )
}

export default function Signali() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { config, wilayas, refreshConfig } = useApp()

  // Where the reporter is in the wizard lives in the URL's #hash (#onsite-0,
  // #onsite-1, #onsite-2, #remote; none = the choice), one history entry
  // per step: the phone's own back button goes back one step instead of
  // leaving the page.
  const location = useLocation()
  const hash = location.hash.slice(1)
  const mode = hash === 'remote' ? 'remote' : hash.startsWith('onsite') ? 'onsite' : null // null = the choice
  const onsiteStep = mode === 'onsite' ? Math.min(2, Number(hash.split('-')[1]) || 0) : 0 // 0 photo, 1 type + details, 2 place + send
  const startedRef = useRef(false) // a step reached from the choice in this visit (not a reload / a way back in)
  const [openSection, setOpenSection] = useState('place') // remote: the open section
  const [typeTouched, setTypeTouched] = useState(false)
  const [detailsDone, setDetailsDone] = useState(false) // remote: Détails passed with its Continuer (Envoyer only then)
  const [anchor, setAnchor] = useState(null) // the picked address's / the GPS fix's position, for "Centrer"
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // --- location ---
  const [locMode, setLocMode] = useState(null) // null | 'gps' | 'manual'
  const [locStatus, setLocStatus] = useState('idle') // idle | locating | success | error
  const [coords, setCoords] = useState(null)
  const [accuracy, setAccuracy] = useState(null)
  const [address, setAddress] = useState('')
  const [wilaya, setWilaya] = useState('') // deduced from the position, never typed
  const [nearMe, setNearMe] = useState(null) // the phone's rough position, to open the map there
  const [nearby, setNearby] = useState([])
  const [confirmedId, setConfirmedId] = useState(null)
  const [adminNote, setAdminNote] = useState(false)

  // --- media ---
  const [photos, setPhotos] = useState([]) // [{file, url}]
  const [video, setVideo] = useState(null) // {blob, url}
  const [camera, setCamera] = useState(null) // live MediaStream while filming
  const [facing, setFacing] = useState('environment')
  const [camMode, setCamMode] = useState('photo') // on site viewfinder: 'photo' | 'video'
  const [viewfinderFailed, setViewfinderFailed] = useState(false) // no camera access: file pickers instead
  const [flash, setFlash] = useState(false)
  const [camOpening, setCamOpening] = useState(false)
  const [filming, setFilming] = useState(false)
  const [videoSec, setVideoSec] = useState(0)

  // --- description ---
  const [categories, setCategories] = useState(['other'])
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


  // The wilaya of a position (GPS, pin, picked address): OSM's boundaries,
  // else the nearest centroid (wilayaGeo.js). The server deduces it from
  // the position too, this one is for the reporter to see.
  // The wizard takes the whole screen (no site header / bottom bar), like
  // an app: only its own ✕, progress and bottom buttons.
  const fullscreen = config.signali_available !== false && !confirmedId
  useEffect(() => {
    if (!fullscreen) return
    document.body.classList.add('sw-page')
    return () => document.body.classList.remove('sw-page')
  }, [fullscreen])

  // On site but no GPS (refused, off, abroad...): the place is asked for
  // by hand at the last step (the photos already taken are kept).
  useEffect(() => {
    if (mode === 'onsite' && locMode === 'gps' && locStatus === 'error') switchToManual()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, locMode, locStatus])

  const prefillWilaya = async ({ latitude, longitude }) => {
    const w = await detectWilaya(latitude, longitude, wilayas)
    if (w?.id) setWilaya(String(w.id))
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
      setAnchor({ latitude, longitude })
      setAccuracy(Number.isFinite(acc) ? Math.round(acc) : null)
      setLocStatus('success')
      prefillWilaya({ latitude, longitude })
      reverseGeocode(latitude, longitude, i18n.language)
        .then((label) => label && setAddress((current) => (current.trim() ? current : label)))
        .catch(() => {})
    } catch (e) {
      setLocStatus('error')
      setError(e?.code === 1 ? t('signali.locationDenied') : t('signali.locationError'))
    }
  }

  const switchToManual = () => {
    setError('')
    setAdminNote(false)
    setLocMode('manual')
    setLocStatus('idle')
    setCoords(null)
    setAccuracy(null)
    // Opens the map around the phone when it can tell where it is (quick,
    // low accuracy is plenty) -- the place itself is still for the
    // reporter to give.
    getCurrentPosition({ enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 })
      .then((pos) => pos && isInAlgeria(pos[0], pos[1]) && setNearMe({ latitude: pos[0], longitude: pos[1] }))
      .catch(() => {})
  }

  // A point placed on the map with no address typed yet: the address
  // under it (OpenStreetMap), which the reporter can correct.
  const onPinMove = (c) => {
    setCoords(c)
    // The first point placed by hand is also what "Centrer" comes back to
    // (when no address was picked from the list, nor a GPS fix taken).
    setAnchor((current) => current || c)
    setError('')
    prefillWilaya(c)
    reverseGeocode(c.latitude, c.longitude, i18n.language)
      .then((label) => label && setAddress((current) => (current.trim() ? current : label)))
      .catch(() => {})
  }

  const onSelectPlace = ({ lat, lon }) => {
    if (!isInAlgeria(lat, lon)) return
    const next = { latitude: lat, longitude: lon }
    setCoords(next)
    setAnchor(next)
    prefillWilaya(next)
  }

  // Manual entry: the place is required, with its position (a picked
  // suggestion or a point on the map) -- the wilaya is deduced from it.
  // Except for an admin testing from abroad (Alger, no position).
  const locationOk =
    locMode === 'gps' ? !!coords : locMode === 'manual' ? !!address.trim() && (!!coords || (adminNote && !!wilaya)) : false

  const selectedWilaya = wilayas.find((w) => String(w.id) === String(wilaya))
  const manualCenter = nearMe ? { ...nearMe, zoom: 14 } : { latitude: 34.5, longitude: 3, zoom: 5 }

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
      if (blob.size > MAX_VIDEO_BYTES) return setError(t('signali.videoTooLarge', { size: MAX_VIDEO_MB }))
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

  // A video file: from the phone's own camera app (fallback for browsers
  // without MediaRecorder, still capped at MAX_VIDEO_SECONDS) or picked
  // from the gallery (only the size is capped -- the server's own limit).
  const pickVideoFile = (e, { fromGallery = false } = {}) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (file.size > MAX_VIDEO_BYTES) return setError(t('signali.videoTooLarge', { size: MAX_VIDEO_MB }))
    const url = track(URL.createObjectURL(file))
    if (fromGallery) {
      setError('')
      return setVideo({ blob: file, url })
    }
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

  // On site: the camera opens straight away, full screen (like the phone's
  // own camera app). Photos are grabbed from the live picture; the video
  // mode reopens it with the microphone (the reporter can talk). Without
  // camera access, the file pickers take over.
  const openViewfinder = async (nextMode = camMode, nextFacing = facing) => {
    setError('')
    if (!navigator.mediaDevices?.getUserMedia) {
      setViewfinderFailed(true)
      return
    }
    setCamOpening(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: nextFacing, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: nextMode === 'video',
      })
      setCamera((prev) => {
        prev?.getTracks().forEach((x) => x.stop())
        return stream
      })
      setViewfinderFailed(false)
    } catch {
      // Refused or no camera: the pickers below still work (the phone's
      // camera app, the gallery).
      setViewfinderFailed(true)
    } finally {
      setCamOpening(false)
    }
  }
  const switchCamMode = (next) => {
    if (next === camMode || filming) return
    if (next === 'video' && video) return
    setCamMode(next)
    openViewfinder(next)
  }
  const flipViewfinder = () => {
    if (filming) return
    const next = facing === 'environment' ? 'user' : 'environment'
    setFacing(next)
    openViewfinder(camMode, next)
  }
  const takeSnapshot = async () => {
    const el = liveVideoRef.current
    if (!el || !el.videoWidth || photos.length >= MAX_PHOTOS) return
    const canvas = document.createElement('canvas')
    canvas.width = el.videoWidth
    canvas.height = el.videoHeight
    canvas.getContext('2d').drawImage(el, 0, 0)
    setFlash(true)
    setTimeout(() => setFlash(false), 180)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    if (!blob) return
    const compressed = await compressPhoto(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }))
    setPhotos((prev) => [...prev, { file: compressed, url: track(URL.createObjectURL(compressed)) }].slice(0, MAX_PHOTOS))
  }
  const shutter = () => {
    if (camMode === 'photo') return takeSnapshot()
    if (filming) return stopRecorder()
    startFilming()
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
    const fields = {
      categories,
      wilaya,
      address: address.trim(),
      latitude: coords ? coords.latitude.toFixed(6) : '',
      longitude: coords ? coords.longitude.toFixed(6) : '',
      position_source: locMode === 'gps' ? 'gps' : 'manual',
      description: description.trim(),
      turnstile_token: window.__turnstileToken || '',
    }
    const build = (withMedia) => {
      const f = new FormData()
      Object.entries(fields).forEach(([k, v]) => {
        if (Array.isArray(v)) v.forEach((x) => f.append(k, x))
        else if (v !== '' && v != null) f.append(k, v)
      })
      if (!withMedia) {
        f.append('media_upload_failed', '1')
        return f
      }
      photos.forEach((p, i) => f.append('photos', p.file, p.file.name || `photo-${i + 1}.jpg`))
      if (video) f.append('video_file', new File([video.blob], `signali-video.${extFor(video.blob.type || '')}`, { type: video.blob.type || 'video/webm' }))
      if (voice) f.append('voice_file', new File([voice.blob], `signali-voice.${extFor(voice.blob.type || '')}`, { type: voice.blob.type || 'audio/webm' }))
      return f
    }
    try {
      let created
      try {
        created = await apiUpload('/signalements/', build(true))
      } catch (e) {
        // The whole upload failed (too big for the connection/proxy, network
        // drop...): send the report anyway, without its media, so nothing
        // the citizen wrote is lost -- the server notes it for the admin.
        // A plain validation error (4xx other than 413) is shown as is.
        if (e?.status && e.status < 500 && e.status !== 413) throw e
        console.warn('[Signali] upload with media failed, retrying without it', e)
        created = await apiUpload('/signalements/', build(false))
      }
      if (created?.id && created.access_token) saveSignalementToken(created.id, created.access_token)
      Promise.resolve(refreshConfig()).catch(() => {})
      navigate(`/signalements/${created.id}`, { replace: true, state: { justCreated: true, mediaWarnings: created.media_warnings || [] } })
    } catch (e) {
      setError(translateApiError(e, t))
    } finally {
      setBusy(false)
    }
  }


  // Not in front of it: a step that becomes valid folds itself (after a
  // short pause, restarted by every change so it never closes under the
  // finger) and the next one to do opens. One reopened while already
  // valid stays open until closed by hand.
  const okBySection = { place: locationOk, media: mediaOk, type: typeTouched || categories[0] !== 'other' }
  const okAtOpenRef = useRef(false)
  useEffect(() => {
    okAtOpenRef.current = !!okBySection[openSection]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSection])
  useEffect(() => {
    if (mode !== 'remote' || !okBySection[openSection] || okAtOpenRef.current || camera || filming) return
    const order = ['place', 'media', 'type', 'details']
    const next = order.slice(order.indexOf(openSection) + 1).find((k) => (k === 'details' ? !detailsDone : !okBySection[k])) || null
    const id = setTimeout(() => setOpenSection(next), openSection === 'place' ? 1200 : 2000)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, openSection, locationOk, mediaOk, typeTouched, categories, coords, address, photos.length, video, camera, filming])

  // A step URL opened cold (reload, or back from the sent report): nothing
  // filled in this visit, so back to the choice.
  useEffect(() => {
    if (mode && !startedRef.current) navigate({ hash: '' }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Moving between steps (buttons or the phone's back button): stop what
  // belongs to the step left behind, reopen the camera when coming back to
  // it, start at the top.
  const stepRef = useRef({ mode, onsiteStep })
  useEffect(() => {
    const prev = stepRef.current
    stepRef.current = { mode, onsiteStep }
    if (prev.mode === mode && prev.onsiteStep === onsiteStep) return
    const onCameraStep = mode === 'onsite' && onsiteStep === 0
    if (filming || recordingVoice) {
      discardRef.current = true
      stopRecorder()
    }
    if (camera && !onCameraStep) closeCamera()
    if (onCameraStep && prev.mode === 'onsite' && prev.onsiteStep > 0 && !viewfinderFailed && photos.length < MAX_PHOTOS) openViewfinder(video ? 'photo' : camMode)
    setError('')
    window.scrollTo(0, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, onsiteStep])

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

  // --- wizard (option "sur place" / "pas devant") ---
  const catLabel = categories.map((c) => t(`signali.categories.${c}`)).join(' · ')
  const typeOk = typeTouched || categories[0] !== 'other'
  const mediaSummary = [photos.length ? t('signali.photosCount', { count: photos.length }) : '', video ? t('signali.videoIncluded') : ''].filter(Boolean).join(' + ')
  const placeLabel = address.trim() || (coords ? (locMode === 'gps' ? t('signali.gpsPosition') : t('signali.pinOnMap')) : '')

  const chooseOnsite = () => {
    startedRef.current = true
    navigate({ hash: '#onsite-0' })
    setCamMode('photo')
    if (!(locMode === 'gps' && coords)) locate()
    openViewfinder('photo')
  }
  const chooseRemote = () => {
    startedRef.current = true
    navigate({ hash: '#remote' })
    setOpenSection(locationOk ? (mediaOk ? 'type' : 'media') : 'place')
    if (locMode !== 'manual') switchToManual()
  }
  const leave = () => navigate('/signalements')
  // The on-screen ← does exactly what the phone's back button does.
  const back = () => {
    if (filming) return
    navigate(-1)
  }
  const nextOnsite = () => navigate({ hash: `#onsite-${onsiteStep + 1}` })
  const onCategories = (next) => {
    setTypeTouched(true)
    setCategories(next)
  }

  const nearbyBlock = coords && nearby.length > 0 && (
    <div className="signali-nearby">
      <strong>{t('signali.nearbyTitle')}</strong>
      <p>{t('signali.nearbyText')}</p>
      {nearby.map((s) => {
        const photo = s.photos.find((p) => p.image)?.image
        return (
          <div className="signali-nearby-item" key={s.id}>
            {photo ? <img src={photo} alt="" /> : <CategoryIcon category={s.category} className="signali-nearby-emoji" />}
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
  )

  // Back to the picked address / the GPS fix after moving the map around.
  const centerButton = anchor && (
    <button type="button" className="sw-center" onClick={() => setCoords({ ...anchor })} aria-label={t('signali.w.center')} title={t('signali.w.center')}>
      <IconLocate width={18} height={18} />
      <span>{t('signali.w.center')}</span>
    </button>
  )

  // Where: an address (Google / OSM suggestions) or the one-hand map.
  const placeBlock = (
    <div className="sw-place">
      {adminNote && <div className="urgent-sos-location-status warning">⚠️ {t('signali.adminOutsideNote')}</div>}
      <div className="sw-addr">
        {centerButton}
        <PlaceAutocomplete
          id="signali-address"
          value={address}
          onChange={setAddress}
          onSelectPlace={onSelectPlace}
          placeholder={t('signali.w.searchPlace')}
          countryCode="dz"
          required
        />
      </div>
      <PinMap position={coords} center={manualCenter} onMove={onPinMove} />
      {!coords && <small className="signali-hint">{address.trim() ? t('signali.noPinHint') : t('signali.tapMapHint')}</small>}
    </div>
  )

  const mediaThumbs = (photos.length > 0 || video) && (
    <div className="sw-shots">
      {photos.map((p, i) => (
        <div className="sw-shot" key={p.url}>
          <img src={p.url} alt={t('common.photoAlt')} />
          <button type="button" onClick={() => removePhoto(i)} aria-label={t('common.delete')}><IconClose width={13} height={13} /></button>
        </div>
      ))}
      {video && (
        <div className="sw-shot sw-shot-video">
          <video src={video.url} controls playsInline preload="metadata" />
          <button type="button" onClick={() => setVideo(null)} aria-label={t('common.delete')}><IconClose width={13} height={13} /></button>
        </div>
      )}
    </div>
  )

  const cameraView = (
    <div className="signali-camera">
      <video ref={liveVideoRef} autoPlay muted playsInline />
      {filming && (
        <div className="urgent-sos-recording active signali-camera-timer">
          <span className="urgent-sos-recording-dot" />
          <strong>{mmss(videoSec)} / {mmss(MAX_VIDEO_SECONDS)}</strong>
        </div>
      )}
      <div className="signali-camera-actions">
        {!filming && <button type="button" className="urgent-sos-secondary" onClick={closeCamera}>{t('common.cancel')}</button>}
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
  )

  // Photo / video sources: the camera first on site, the gallery first
  // from elsewhere.
  const photoFull = photos.length >= MAX_PHOTOS
  const sources = {
    photo: (
      <label key="photo" className={`sw-src${photoFull ? ' is-off' : ''}`}>
        <span className="sw-ico is-navy"><IconCamera width={22} height={22} /></span>
        <b>{t('signali.w.takePhoto')}<small>{photos.length}/{MAX_PHOTOS}</small></b>
        <input type="file" accept="image/*" capture="environment" onChange={addPhotos} hidden disabled={photoFull} />
      </label>
    ),
    video: (
      <button key="video" type="button" className={`sw-src${video ? ' is-off' : ''}`} onClick={startVideo} disabled={!!video}>
        <span className="sw-ico"><IconVideoCam width={22} height={22} /></span>
        <b>{t('signali.w.filmVideo')}<small>{t('signali.videoMax', { max: MAX_VIDEO_SECONDS })}</small></b>
      </button>
    ),
    gallery: (
      <label key="gallery" className={`sw-src${photoFull ? ' is-off' : ''}`}>
        <span className="sw-ico is-navy"><IconGallery width={22} height={22} /></span>
        <b>{t('signali.w.gallery')}<small>{photos.length}/{MAX_PHOTOS}</small></b>
        <input type="file" accept="image/*" multiple onChange={addPhotos} hidden disabled={photoFull} />
      </label>
    ),
    galleryVideo: (
      <label key="galleryVideo" className={`sw-src${video ? ' is-off' : ''}`}>
        <span className="sw-ico"><IconVideoUpload width={22} height={22} /></span>
        <b>{t('signali.w.galleryVideo')}<small>{t('signali.videoFromGalleryMax', { size: MAX_VIDEO_MB })}</small></b>
        <input type="file" accept="video/*" onChange={(e) => pickVideoFile(e, { fromGallery: true })} hidden disabled={!!video} />
      </label>
    ),
  }
  const mediaBlock = (galleryFirst) =>
    camera ? (
      cameraView
    ) : (
      <>
        {mediaThumbs}
        <div className="sw-sources">
          {(galleryFirst ? ['gallery', 'galleryVideo', 'photo', 'video'] : ['photo', 'video', 'gallery', 'galleryVideo']).map((k) => sources[k])}
        </div>
        <input id="signali-video-file" type="file" accept="video/*" capture="environment" onChange={pickVideoFile} hidden />
      </>
    )

  const voiceBlock = recordingVoice ? (
    <div className="sw-rec">
      <span className="sw-rec-dot" />
      <b>{mmss(voiceSec)}</b>
      <span className="sw-wave" aria-hidden="true">
        {Array.from({ length: 14 }, (_, i) => <i key={i} style={{ animationDelay: `${(i % 7) * 0.09}s` }} />)}
      </span>
      <button type="button" onClick={stopRecorder}>{t('signali.stop')}</button>
    </div>
  ) : voice ? (
    <div className="sw-audio">
      <audio src={voice.url} controls preload="metadata" />
      <button type="button" onClick={() => setVoice(null)}>{t('signali.rerecord')}</button>
    </div>
  ) : (
    <button type="button" className="sw-src sw-voice" onClick={startVoice}>
      <span className="sw-ico is-red"><IconMic width={20} height={20} /></span>
      <b>{t('signali.w.voice')}<small>{t('signali.w.optional')}</small></b>
    </button>
  )
  const detailsBlock = (
    <>
      <textarea id="signali-description" className="sw-text" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('signali.w.detailPlaceholder')} maxLength={2000} aria-label={t('signali.textLabel')} />
      {voiceBlock}
    </>
  )

  const turnstile = config.turnstile_enabled && (
    <div
      className="cf-turnstile urgent-sos-turnstile"
      data-sitekey={config.turnstile_site_key}
      data-callback="onSignaliTurnstileToken"
      ref={(el) => {
        if (el) window.onSignaliTurnstileToken = (v) => (window.__turnstileToken = v)
      }}
    />
  )
  const errorLine = error && <p className="urgent-sos-error">{error}</p>
  // Remote: every step gone through (Détails passed with its Continuer).
  const sendReady = locationOk && mediaOk && !recordingVoice && (mode !== 'remote' || (typeOk && detailsDone))
  const sendButton = (
    <button type="button" className={`sw-next is-full${sendReady ? ' is-ready' : ''}`} onClick={submit} disabled={busy || !sendReady}>
      {busy ? t('signali.sending') : t('signali.w.send')}
    </button>
  )

  // GPS state, top right, on site.
  const gpsChip =
    locMode === 'gps' && locStatus === 'locating' ? (
      <span className="sw-chip">{t('signali.locating')}</span>
    ) : coords && locMode === 'gps' ? (
      <span className="sw-chip is-ok">📍 {selectedWilaya?.name || t('signali.w.gpsOk')}{accuracy ? ` · ±${accuracy} m` : ''}</span>
    ) : (
      <span className="sw-chip is-warn">📍 {t('signali.w.placeToSet')}</span>
    )

  const badge = (ok, optional) =>
    ok ? <span className="sw-badge is-ok">✓ {t('signali.w.done')}</span> : <span className="sw-badge">{optional ? t('signali.w.optional') : t('signali.w.todo')}</span>
  // A section: its title, its state, and -- while open -- its Continuer up
  // in the header (always in view, even above a tall map), pulsing once
  // the step is valid.
  const section = (key, n, title, ok, summary, body, { optional = false, onContinue } = {}) => {
    const open = openSection === key
    const canContinue = ok || optional
    return (
      <div className={`sw-acc${open ? ' is-open' : ''}${ok && !open ? ' is-ok' : ''}`}>
        <div className="sw-acc-top">
          <button type="button" className="sw-acc-head" onClick={() => setOpenSection(open ? null : key)} aria-expanded={open}>
            <b>{n}. {title}</b>
            {!open && summary && <small>{summary}</small>}
          </button>
          {open && canContinue ? (
            <button type="button" className="sw-acc-go" onClick={onContinue}>
              {t('signali.continue')} →
            </button>
          ) : (
            badge(ok, optional)
          )}
        </div>
        {open && <div className="sw-acc-body">{body}</div>}
      </div>
    )
  }
  const nextOpen = (from) => {
    const order = ['place', 'media', 'type', 'details']
    const ok = { place: locationOk, media: mediaOk, type: typeOk, details: detailsDone }
    return order.slice(order.indexOf(from) + 1).find((k) => !ok[k]) || null
  }

  const onsiteTitles = [t('signali.w.photoTitle'), t('signali.w.typeTitle'), catLabel]
  const canNext = onsiteStep === 0 ? mediaOk && !camera : typeOk && !recordingVoice

  // On site, step 1: the live camera, full screen.
  if (mode === 'onsite' && onsiteStep === 0 && (camera || camOpening)) {
    const count = photos.length + (video ? 1 : 0)
    return (
      <section className="sw-cam">
        <video ref={liveVideoRef} autoPlay muted playsInline className={facing === 'user' ? 'is-mirror' : ''} />
        {flash && <div className="sw-cam-flash" />}
        <div className="sw-cam-top">
          <button type="button" className="sw-x is-dark" onClick={back} aria-label={t('signali.previous')} disabled={filming}>
            <IconArrowLeft width={18} height={18} />
          </button>
          {gpsChip}
        </div>
        {filming && (
          <div className="sw-cam-timer">
            <span className="sw-rec-dot" /> {mmss(videoSec)} / {mmss(MAX_VIDEO_SECONDS)}
          </div>
        )}
        <div className="sw-cam-bottom">
          {count > 0 && !filming && <p className="sw-cam-hint">{t('signali.w.camHint', { max: MAX_PHOTOS })}</p>}
          {count > 0 && !filming && (
            <div className="sw-cam-shots">
              <div className="sw-cam-thumbs">
                {photos.map((p, i) => (
                  <button key={p.url} type="button" onClick={() => removePhoto(i)} aria-label={t('common.delete')}>
                    <img src={p.url} alt="" />
                  </button>
                ))}
              </div>
              <button type="button" className="sw-cam-continue" onClick={nextOnsite}>
                {t('signali.continue')} ({count})
              </button>
            </div>
          )}
          {!filming && (
            <div className="sw-cam-modes" role="tablist">
              <button type="button" role="tab" aria-selected={camMode === 'video'} className={camMode === 'video' ? 'is-on' : ''} onClick={() => switchCamMode('video')} disabled={!!video}>
                {t('signali.w.modeVideo')}
              </button>
              <button type="button" role="tab" aria-selected={camMode === 'photo'} className={camMode === 'photo' ? 'is-on' : ''} onClick={() => switchCamMode('photo')}>
                {t('signali.w.modePhoto')}
              </button>
            </div>
          )}
          <div className="sw-cam-ctl">
            <label className={`sw-cam-mini${photoFull || filming ? ' is-off' : ''}`} aria-label={t('signali.w.gallery')}>
              <IconGallery width={22} height={22} />
              <input type="file" accept="image/*,video/*" multiple onChange={(e) => {
                const files = Array.from(e.target.files || [])
                const vid = files.find((f) => f.type.startsWith('video/'))
                if (vid && !video) pickVideoFile({ target: { files: [vid], value: '' } }, { fromGallery: true })
                addPhotos({ target: { files: files.filter((f) => f.type.startsWith('image/')), value: '' } })
                e.target.value = ''
              }} hidden disabled={photoFull || filming} />
            </label>
            <button
              type="button"
              className={`sw-shutter${camMode === 'video' ? ' is-video' : ''}${filming ? ' is-rec' : ''}`}
              onClick={shutter}
              disabled={camMode === 'photo' && photoFull}
              aria-label={camMode === 'photo' ? t('signali.w.takePhoto') : filming ? t('signali.stop') : t('signali.record')}
            >
              <i />
            </button>
            <button type="button" className="sw-cam-mini" onClick={flipViewfinder} disabled={filming} aria-label={t('signali.switchCamera')}>
              <IconSwitchCamera width={22} height={22} />
            </button>
          </div>
        </div>
        {error && <p className="sw-cam-error">{error}</p>}
      </section>
    )
  }

  return (
    <section className="sw">
      <header className="sw-top">
        <button type="button" className="sw-x" onClick={mode ? back : leave} aria-label={mode ? t('signali.previous') : t('common.close')}>
          {mode ? <IconArrowLeft width={18} height={18} /> : <IconClose width={18} height={18} />}
        </button>
        {mode === 'remote' && <b className="sw-top-title">{t('signali.w.newReport')}</b>}
        {mode === 'onsite' ? gpsChip : <span className="sw-top-spacer" />}
      </header>
      {mode === 'onsite' && (
        <div className="sw-bar">
          <i style={{ width: `${((onsiteStep + 1) / 3) * 100}%` }} />
        </div>
      )}

      {!mode && (
        <div className="sw-body">
          <h1 className="sw-title">{t('signali.w.title')}</h1>
          <button type="button" className="sw-mode is-main" onClick={chooseOnsite}>
            <span className="sw-ico is-navy is-big"><IconCamera width={28} height={28} /></span>
            <span>
              <b>{t('signali.w.onsite')}</b>
              <small>{t('signali.w.onsiteSub')}</small>
              <em>{t('signali.w.fast')}</em>
            </span>
          </button>
          <button type="button" className="sw-mode" onClick={chooseRemote}>
            <span className="sw-ico is-big"><IconGallery width={28} height={28} /></span>
            <span>
              <b>{t('signali.w.remote')}</b>
              <small>{t('signali.w.remoteSub')}</small>
            </span>
          </button>
        </div>
      )}

      {mode === 'onsite' && (
        <>
          <div className="sw-body">
            <h1 className="sw-title">{onsiteTitles[onsiteStep]}</h1>
            {onsiteStep === 0 && mediaBlock(false)}
            {onsiteStep === 1 && (
              <>
                <CategoryPicker value={categories} onChange={onCategories} />
                {detailsBlock}
              </>
            )}
            {onsiteStep === 2 && (
              <>
                {locMode === 'gps' && coords ? (
                  <div className="sw-place">
                    <PinMap position={coords} onMove={onPinMove} />
                    <div className="sw-addr">
                      {centerButton}
                      <p className="sw-where">📍 {placeLabel}</p>
                    </div>
                  </div>
                ) : locMode === 'gps' && locStatus === 'locating' ? (
                  <p className="sw-where">{t('signali.locating')}</p>
                ) : (
                  placeBlock
                )}
                {nearbyBlock}
                <div className="sw-recap">
                  {photos[0] ? <img src={photos[0].url} alt="" /> : <span className="sw-ico"><IconVideoCam width={22} height={22} /></span>}
                  <span>
                    <b>{mediaSummary}</b>
                    <small>{[description.trim() ? t('signali.w.withText') : '', voice ? t('signali.w.voice') : ''].filter(Boolean).join(' · ')}</small>
                  </span>
                </div>
                {turnstile}
              </>
            )}
            {errorLine}
          </div>
          <footer className="sw-foot">
            {onsiteStep < 2 ? (
              <>
                <button type="button" className="sw-back" onClick={back} disabled={recordingVoice || filming}>{t('signali.previous')}</button>
                <button type="button" className={`sw-next${canNext ? ' is-ready' : ''}`} onClick={nextOnsite} disabled={!canNext}>{t('signali.w.next')}</button>
              </>
            ) : (
              sendButton
            )}
          </footer>
        </>
      )}

      {mode === 'remote' && (
        <>
          <div className="sw-body">
            {section('place', 1, t('signali.w.place'), locationOk, placeLabel, (
              <>
                {placeBlock}
                {nearbyBlock}
              </>
            ), { onContinue: () => setOpenSection(nextOpen('place')) })}
            {section('media', 2, t('signali.w.media'), mediaOk, mediaSummary, mediaBlock(true), { onContinue: () => setOpenSection(nextOpen('media')) })}
            {section('type', 3, t('signali.w.type'), typeOk, typeOk ? catLabel : '', <CategoryPicker value={categories} onChange={onCategories} />, { onContinue: () => setOpenSection(nextOpen('type')) })}
            {section('details', 4, t('signali.w.details'), detailsDone, [description.trim() ? t('signali.w.withText') : '', voice ? t('signali.w.voice') : ''].filter(Boolean).join(' · '), detailsBlock, {
              optional: true,
              onContinue: () => {
                if (recordingVoice) stopRecorder()
                setDetailsDone(true)
                setOpenSection(null)
              },
            })}
            {turnstile}
            {errorLine}
          </div>
          <footer className="sw-foot">{sendButton}</footer>
        </>
      )}
    </section>
  )
}
