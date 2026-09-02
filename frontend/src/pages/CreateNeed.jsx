import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api, createOrQueue } from '../api'
import { compressPhoto, isInAlgeria, reverseGeocodePlace } from '../utils'
import { translateApiError } from '../apiErrors'
import { IconMapPin, IconMic, IconVideoCam, IconCamera, IconTrash } from '../icons'
import PlaceAutocomplete from '../components/PlaceAutocomplete'

const DEFAULT_FORM = {
  campaign: '',
  wilaya: '',
  commune: '',
  urgency: 'medium',
  estimated_quantity: '',
  location_description: '',
  latitude: null,
  longitude: null,
  contact_name: '',
  contact_phone: '',
  contact_email: '',
  organization_or_person_name: '',
  recovery_code: '',
}

export default function CreateNeed() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { campaigns, wilayasForCampaign, wilayas, saveNeedToken, config } = useApp()
  const { showConfirm, showAlert } = useDialog()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [gpsStatus, setGpsStatus] = useState(null) // null | 'locating' | 'error'
  const [error, setError] = useState('')
  const [uploadStatus, setUploadStatus] = useState('')
  const [damagePhotos, setDamagePhotos] = useState([])
  // Voice and video are independent, combinable recordings (not a single
  // either/or choice) -- only one can be actively recording at a time
  // (shared mic/camera access), but once stopped each is kept and
  // discardable/re-recordable on its own.
  const [recordingKind, setRecordingKind] = useState(null) // null | 'voice' | 'video'
  const [seconds, setSeconds] = useState(0)
  const [voiceBlob, setVoiceBlob] = useState(null)
  const [voiceBlobUrl, setVoiceBlobUrl] = useState(null)
  const [videoBlob, setVideoBlob] = useState(null)
  const [videoBlobUrl, setVideoBlobUrl] = useState(null)
  const mediaRecorderRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const turnstileTokenRef = useRef('')

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const activeCampaign = campaigns.find((c) => c.status === 'active')

  // Only one campaign is ever active at a time (see migration
  // 0007_wildfire_campaign) -- lock the form to it instead of asking the
  // reporter to pick, one less decision for someone in an emergency.
  useEffect(() => {
    if (activeCampaign && form.campaign !== String(activeCampaign.id)) {
      setForm((f) => ({ ...f, campaign: String(activeCampaign.id) }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCampaign])

  const setUrgent = (e) => setForm((f) => ({ ...f, urgency: e.target.checked ? 'critical' : 'medium' }))

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setGpsStatus('error')
      return
    }
    setGpsStatus('locating')
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        let { latitude, longitude } = pos.coords
        // An admin testing/reporting from outside Algeria would otherwise
        // hit the backend's "coordinates outside Algeria" validation on
        // submit -- default to Algiers instead of erroring out, since the
        // point here is exercising/administering the app, not a real
        // report of a need physically outside the country.
        if (!isInAlgeria(latitude, longitude) && config.is_admin) {
          const alger = wilayas.find((w) => w.name === 'Alger')
          if (alger && alger.centroid_latitude != null) {
            latitude = alger.centroid_latitude
            longitude = alger.centroid_longitude
          }
        }
        setGpsStatus(null)
        setForm((f) => ({ ...f, latitude, longitude }))
        try {
          const suggestion = await api(`/wilayas/nearest/?lat=${latitude}&lon=${longitude}`)
          setForm((f) => (f.wilaya ? f : { ...f, wilaya: suggestion.id }))
        } catch {
          /* best-effort only */
        }
        try {
          const place = await reverseGeocodePlace(latitude, longitude, i18n.language)
          if (place) setForm((f) => ({ ...f, commune: place }))
        } catch {
          /* best-effort only -- the place field just stays whatever it already was */
        }
      },
      () => setGpsStatus('error'),
      { timeout: 8000 }
    )
  }, [config.is_admin, wilayas, i18n.language])

  // Lets a visitor recover from a bad GPS read (wrong network/IP-based
  // fallback, a stale cached position, simply changing their mind) --
  // previously there was no way to clear a captured/errored position
  // short of reloading the whole page.
  const clearLocation = () => {
    setGpsStatus(null)
    setForm((f) => ({ ...f, latitude: null, longitude: null }))
  }

  const startRecording = async (kind) => {
    if (recordingKind) return // one at a time (shared mic/camera)
    const constraints = kind === 'video' ? { video: { facingMode: 'environment' }, audio: true } : { audio: true }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    const mediaRecorder = new MediaRecorder(stream)
    const chunks = []
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    mediaRecorder.onstop = () => {
      const b = new Blob(chunks, { type: mediaRecorder.mimeType || (kind === 'video' ? 'video/webm' : 'audio/webm') })
      const url = URL.createObjectURL(b)
      if (kind === 'video') {
        setVideoBlob(b)
        setVideoBlobUrl(url)
      } else {
        setVoiceBlob(b)
        setVoiceBlobUrl(url)
      }
      stream.getTracks().forEach((t) => t.stop())
    }
    mediaRecorderRef.current = mediaRecorder
    streamRef.current = stream
    setSeconds(0)
    setRecordingKind(kind)
    mediaRecorder.start()
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        const next = s + 1
        if (kind === 'video' && next >= 20) stopRecording() // hard cap, spec Wave 2
        return next
      })
    }, 1000)
  }

  const stopRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    setRecordingKind(null)
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
  }

  const discardRecording = (kind) => {
    if (kind === 'video') {
      if (videoBlobUrl) URL.revokeObjectURL(videoBlobUrl)
      setVideoBlob(null)
      setVideoBlobUrl(null)
    } else {
      if (voiceBlobUrl) URL.revokeObjectURL(voiceBlobUrl)
      setVoiceBlob(null)
      setVoiceBlobUrl(null)
    }
  }

  const addDamagePhoto = async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file || damagePhotos.length >= 3) return
    const compressed = await compressPhoto(file)
    setDamagePhotos((prev) => [...prev, { file: compressed, previewUrl: URL.createObjectURL(compressed) }])
  }

  const submit = async (e, skipDuplicateCheck) => {
    e.preventDefault()
    setError('')
    const description = form.location_description.trim()
    if (!description && !voiceBlob && !videoBlob) {
      setError(t('createNeed.atLeastOneMediaRequired'))
      return
    }
    // There's no separate "title" field in the UI anymore -- one field,
    // "describe the need", covers both. Derive a short title from it for
    // list/map display (the backend still stores title separately), or
    // fall back to a generic label when only voice/video was provided.
    const title = description ? (description.length > 197 ? description.slice(0, 197) + '…' : description) : t('createNeed.fallbackTitle')
    try {
      if (!skipDuplicateCheck && form.wilaya) {
        const dupes = await api(
          `/needs/check-duplicates/?wilaya=${form.wilaya}&title=${encodeURIComponent(title)}&description=${encodeURIComponent(description)}`
        ).catch(() => [])
        if (dupes && dupes.length) {
          const proceed = await showConfirm(t('createNeed.duplicateWarning', { title: dupes[0].title, wilaya: dupes[0].wilaya_name }))
          if (!proceed) {
            navigate(`/needs/${dupes[0].id}`)
            return
          }
        }
      }

      const fields = { ...form, title, turnstile_token: turnstileTokenRef.current || window.__turnstileToken || '' }
      const files = {}
      if (voiceBlob) files.voice_file = new File([voiceBlob], 'voice.webm', { type: voiceBlob.type })
      if (videoBlob) files.video_file = new File([videoBlob], 'video.webm', { type: videoBlob.type })
      if (damagePhotos.length) files.damage_photos = damagePhotos.map((p) => p.file)

      const result = await createOrQueue({ type: 'need', endpoint: '/api/needs/', fields, files, onStatus: setUploadStatus })
      if (result.queued) {
        showAlert(t('offline.pendingSync'))
        navigate('/needs')
        return
      }
      const need = result.data
      saveNeedToken(need.id, { access_token: need.access_token, location_viewer_share_token: need.location_viewer_share_token })
      navigate(`/needs/${need.id}`)
    } catch (err) {
      setError(translateApiError(err, t))
    }
  }

  return (
    <section className="form-page">
      <h2>{t('createNeed.title')}</h2>
      <form onSubmit={submit}>
        <label>
          {t('createNeed.campaign')}
          <select value={form.campaign} disabled required>
            {activeCampaign ? (
              <option value={activeCampaign.id}>{activeCampaign.campaign_name}</option>
            ) : (
              <option value="">{t('createNeed.selectPlaceholder')}</option>
            )}
          </select>
        </label>
        <label>
          {t('createNeed.wilaya')} *
          <select value={form.wilaya} onChange={set('wilaya')} required>
            <option value="">{t('createNeed.selectPlaceholder')}</option>
            {wilayasForCampaign(form.campaign).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('createNeed.place')}
          <PlaceAutocomplete
            value={form.commune}
            onChange={(v) => setForm((f) => ({ ...f, commune: v }))}
            onSelectPlace={({ lat, lon }) => {
              setGpsStatus(null)
              setForm((f) => ({ ...f, latitude: lat, longitude: lon }))
            }}
            placeholder={t('createNeed.placePlaceholder')}
          />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" checked={form.urgency === 'critical'} onChange={setUrgent} />
          {t('createNeed.urgentCheckbox')}
        </label>
        <label>
          {t('createNeed.estimatedQuantity')}
          <input
            type="number"
            min="0"
            inputMode="numeric"
            value={form.estimated_quantity}
            onChange={set('estimated_quantity')}
            placeholder={t('createNeed.estimatedQuantityPlaceholder')}
          />
        </label>
        <label>
          {t('createNeed.description')}
          <textarea value={form.location_description} onChange={set('location_description')} placeholder={t('createNeed.descriptionPlaceholder')} />
        </label>
        <div className="gps-controls">
          <button type="button" className="btn btn-icon" onClick={useMyLocation} disabled={gpsStatus === 'locating'}>
            <IconMapPin width={16} height={16} strokeWidth={2} /> {t('createNeed.useMyLocation')}
          </button>
          {(gpsStatus === 'error' || form.latitude) && (
            <button type="button" className="link" onClick={clearLocation}>
              {t('createNeed.clearGps')}
            </button>
          )}
        </div>
        {!config.is_admin && <p className="hint">{t('createNeed.gpsAlgeriaOnly')}</p>}
        {gpsStatus === 'locating' && <p className="hint">{t('createNeed.gpsLocating')}</p>}
        {gpsStatus === 'error' && <p className="error">{t('createNeed.gpsError')}</p>}
        {form.latitude && !gpsStatus && <p>{t('createNeed.gpsCaptured', { lat: form.latitude, lon: form.longitude })}</p>}

        <fieldset>
          <legend>{t('createNeed.mediaSectionLegend')}</legend>
          <p className="hint">{t('createNeed.atLeastOneMediaHint')}</p>
          <div className="media-capture-grid">
            <div className="media-capture-card">
              <IconMic width={28} height={28} strokeWidth={1.5} />
              <span>{t('createNeed.mediaVoice')}</span>
              {!voiceBlobUrl && recordingKind !== 'voice' && (
                <button type="button" className="btn record-btn" onClick={() => startRecording('voice')} disabled={!!recordingKind}>
                  {t('createNeed.startRecording')}
                </button>
              )}
              {recordingKind === 'voice' && (
                <button type="button" className="btn btn-danger record-btn" onClick={stopRecording}>
                  {t('createNeed.stopRecording', { seconds })}
                </button>
              )}
              {voiceBlobUrl && recordingKind !== 'voice' && (
                <>
                  <audio src={voiceBlobUrl} controls />
                  <button type="button" className="btn btn-icon" onClick={() => discardRecording('voice')}>
                    <IconTrash width={16} height={16} strokeWidth={2} /> {t('createNeed.discardRerecord')}
                  </button>
                </>
              )}
            </div>
            <div className="media-capture-card">
              <IconVideoCam width={28} height={28} strokeWidth={1.5} />
              <span>{t('createNeed.mediaVideo')}</span>
              {!videoBlobUrl && recordingKind !== 'video' && (
                <button type="button" className="btn record-btn" onClick={() => startRecording('video')} disabled={!!recordingKind}>
                  {t('createNeed.startRecording')}
                </button>
              )}
              {recordingKind === 'video' && (
                <button type="button" className="btn btn-danger record-btn" onClick={stopRecording}>
                  {t('createNeed.stopRecording', { seconds })}
                </button>
              )}
              {videoBlobUrl && recordingKind !== 'video' && (
                <>
                  <video className="media-player" src={videoBlobUrl} controls playsInline />
                  <button type="button" className="btn btn-icon" onClick={() => discardRecording('video')}>
                    <IconTrash width={16} height={16} strokeWidth={2} /> {t('createNeed.discardRerecord')}
                  </button>
                </>
              )}
            </div>
            <div className="media-capture-card">
              <IconCamera width={28} height={28} strokeWidth={1.5} />
              <span>{t('createNeed.mediaPhoto')}</span>
              {damagePhotos.length < 3 && (
                <label className="btn record-btn photo-add-btn">
                  {t('createNeed.startRecording')}
                  <input type="file" accept="image/*" capture="environment" onChange={addDamagePhoto} hidden />
                </label>
              )}
              {damagePhotos.length > 0 && (
                <div className="photo-thumbs">
                  {damagePhotos.map((p, idx) => (
                    <div className="photo-thumb" key={idx}>
                      <img src={p.previewUrl} alt="" />
                      <button type="button" className="link" onClick={() => setDamagePhotos((prev) => prev.filter((_, i) => i !== idx))}>
                        <IconTrash width={14} height={14} strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>{t('createNeed.contactDetailsLegend')}</legend>
          <label>
            {t('createNeed.name')} * <input type="text" value={form.contact_name} onChange={set('contact_name')} required />
          </label>
          <label>
            {t('createNeed.phone')} * <input type="tel" value={form.contact_phone} onChange={set('contact_phone')} required />
          </label>
          <label>
            {t('createNeed.email')} <input type="email" value={form.contact_email} onChange={set('contact_email')} />
          </label>
          <label>
            {t('createNeed.orgOrPerson')} <input type="text" value={form.organization_or_person_name} onChange={set('organization_or_person_name')} />
          </label>
          <label>
            {t('createNeed.recoveryCode')}{' '}
            <input type="text" value={form.recovery_code} onChange={set('recovery_code')} placeholder={t('createNeed.recoveryCodePlaceholder')} minLength={6} />
            <span className="hint">{t('createNeed.recoveryCodeHint')}</span>
          </label>
        </fieldset>

        {config.turnstile_enabled && (
          <div
            className="cf-turnstile"
            data-sitekey={config.turnstile_site_key}
            data-callback="onTurnstileToken"
            ref={(el) => {
              if (el) window.onTurnstileToken = (token) => (turnstileTokenRef.current = token)
            }}
          />
        )}
        {error && <p className="error">{error}</p>}
        {uploadStatus && <p className="upload-status">{uploadStatus}</p>}
        <button type="submit" className="btn btn-primary">
          {t('createNeed.publish')}
        </button>
      </form>
    </section>
  )
}
