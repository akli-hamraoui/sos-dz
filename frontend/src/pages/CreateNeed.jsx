import { useState, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api, createOrQueue } from '../api'
import { compressPhoto } from '../utils'

const DEFAULT_FORM = {
  campaign: '',
  wilaya: '',
  commune: '',
  title: '',
  urgency: 'medium',
  estimated_quantity: '',
  location_description: '',
  latitude: null,
  longitude: null,
  contact_last_name: '',
  contact_first_name: '',
  contact_phone: '',
  contact_date_of_birth: '',
  contact_email: '',
  organization_or_person_name: '',
  media_type: 'text',
}

export default function CreateNeed() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { campaigns, wilayasForCampaign, saveNeedToken, config } = useApp()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [error, setError] = useState('')
  const [uploadStatus, setUploadStatus] = useState('')
  const [damagePhotos, setDamagePhotos] = useState([])
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [blob, setBlob] = useState(null)
  const [blobUrl, setBlobUrl] = useState(null)
  const mediaRecorderRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const turnstileTokenRef = useRef('')

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(async (pos) => {
      setForm((f) => ({ ...f, latitude: pos.coords.latitude, longitude: pos.coords.longitude }))
      try {
        const suggestion = await api(`/wilayas/nearest/?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`)
        setForm((f) => (f.wilaya ? f : { ...f, wilaya: suggestion.id }))
      } catch {
        /* best-effort only */
      }
    })
  }, [])

  const startRecording = async (kind) => {
    const constraints = kind === 'video' ? { video: { facingMode: 'environment' }, audio: true } : { audio: true }
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    const mediaRecorder = new MediaRecorder(stream)
    const chunks = []
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data)
    }
    mediaRecorder.onstop = () => {
      const b = new Blob(chunks, { type: mediaRecorder.mimeType || (kind === 'video' ? 'video/webm' : 'audio/webm') })
      setBlob(b)
      setBlobUrl(URL.createObjectURL(b))
      stream.getTracks().forEach((t) => t.stop())
    }
    mediaRecorderRef.current = mediaRecorder
    streamRef.current = stream
    setSeconds(0)
    setRecording(true)
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
    setRecording(false)
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
  }

  const discardRecording = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop())
    if (blobUrl) URL.revokeObjectURL(blobUrl)
    setBlob(null)
    setBlobUrl(null)
    setSeconds(0)
    setRecording(false)
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
    try {
      if (!skipDuplicateCheck && form.wilaya) {
        const dupes = await api(
          `/needs/check-duplicates/?wilaya=${form.wilaya}&title=${encodeURIComponent(form.title)}&description=${encodeURIComponent(form.location_description)}`
        ).catch(() => [])
        if (dupes && dupes.length) {
          const proceed = confirm(t('createNeed.duplicateWarning', { title: dupes[0].title, wilaya: dupes[0].wilaya_name }))
          if (!proceed) {
            navigate(`/needs/${dupes[0].id}`)
            return
          }
        }
      }

      const fields = { ...form, turnstile_token: turnstileTokenRef.current || window.__turnstileToken || '' }
      const files = {}
      if (form.media_type !== 'text' && blob) files.media_file = new File([blob], 'recording.webm', { type: blob.type })
      if (damagePhotos.length) files.damage_photos = damagePhotos.map((p) => p.file)

      const result = await createOrQueue({ type: 'need', endpoint: '/api/needs/', fields, files, onStatus: setUploadStatus })
      if (result.queued) {
        alert(t('offline.pendingSync'))
        navigate('/needs')
        return
      }
      const need = result.data
      saveNeedToken(need.id, { access_token: need.access_token, location_viewer_share_token: need.location_viewer_share_token })
      navigate(`/needs/${need.id}`)
    } catch (err) {
      setError((err.data && JSON.stringify(err.data)) || err.message)
    }
  }

  return (
    <section className="form-page">
      <h2>{t('createNeed.title')}</h2>
      <form onSubmit={submit}>
        <label>
          {t('createNeed.campaign')}
          <select value={form.campaign} onChange={set('campaign')} required>
            <option value="">{t('createNeed.selectPlaceholder')}</option>
            {campaigns
              .filter((c) => c.status === 'active')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.campaign_name}
                </option>
              ))}
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
          {t('createNeed.commune')}
          <input type="text" value={form.commune} onChange={set('commune')} />
        </label>
        <label>
          {t('createNeed.typeOfNeed')} *
          <input type="text" value={form.title} onChange={set('title')} placeholder={t('createNeed.typeOfNeedPlaceholder')} required />
        </label>
        <label>
          {t('createNeed.urgency')} *
          <select value={form.urgency} onChange={set('urgency')} required>
            <option value="low">{t('urgency.low')}</option>
            <option value="medium">{t('urgency.medium')}</option>
            <option value="critical">{t('urgency.critical')}</option>
          </select>
        </label>
        <label>
          {t('createNeed.estimatedQuantity')}
          <input type="text" value={form.estimated_quantity} onChange={set('estimated_quantity')} placeholder={t('createNeed.estimatedQuantityPlaceholder')} />
        </label>
        <label>
          {t('createNeed.description')} *
          <textarea value={form.location_description} onChange={set('location_description')} placeholder={t('createNeed.descriptionPlaceholder')} required />
        </label>
        <button type="button" className="btn" onClick={useMyLocation}>
          {t('createNeed.useMyLocation')}
        </button>
        {form.latitude && <p>{t('createNeed.gpsCaptured', { lat: form.latitude, lon: form.longitude })}</p>}

        <fieldset>
          <legend>{t('createNeed.mediaSectionLegend')}</legend>
          <div className="media-choice">
            <label>
              <input type="radio" name="mediaType" value="text" checked={form.media_type === 'text'} onChange={set('media_type')} />
              {t('createNeed.mediaTextOnly')}
            </label>
            <label>
              <input type="radio" name="mediaType" value="audio" checked={form.media_type === 'audio'} onChange={set('media_type')} />
              {t('createNeed.mediaVoice')}
            </label>
            <label>
              <input type="radio" name="mediaType" value="video" checked={form.media_type === 'video'} onChange={set('media_type')} />
              {t('createNeed.mediaVideo')}
            </label>
          </div>
          {form.media_type !== 'text' && (
            <div className="recorder">
              {!blobUrl && !recording && (
                <button type="button" className="btn record-btn" onClick={() => startRecording(form.media_type)}>
                  {t('createNeed.startRecording')}
                </button>
              )}
              {recording && (
                <button type="button" className="btn btn-danger record-btn" onClick={stopRecording}>
                  {t('createNeed.stopRecording', { seconds })}
                </button>
              )}
              {blobUrl && !recording && (
                <div>
                  {form.media_type === 'audio' ? <audio src={blobUrl} controls /> : <video src={blobUrl} controls style={{ maxWidth: '100%' }} />}
                  <br />
                  <button type="button" className="btn" onClick={discardRecording}>
                    {t('createNeed.discardRerecord')}
                  </button>
                </div>
              )}
            </div>
          )}
        </fieldset>

        <fieldset>
          <legend>{t('createNeed.damagePhotosLegend')}</legend>
          {damagePhotos.length < 3 && <input type="file" accept="image/*" capture="environment" onChange={addDamagePhoto} />}
          <div className="photo-thumbs">
            {damagePhotos.map((p, idx) => (
              <div className="photo-thumb" key={idx}>
                <img src={p.previewUrl} alt="" />
                <button type="button" className="link" onClick={() => setDamagePhotos((prev) => prev.filter((_, i) => i !== idx))}>
                  {t('createNeed.remove')}
                </button>
              </div>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>{t('createNeed.contactDetailsLegend')}</legend>
          <label>
            {t('createNeed.lastName')} * <input type="text" value={form.contact_last_name} onChange={set('contact_last_name')} required />
          </label>
          <label>
            {t('createNeed.firstName')} * <input type="text" value={form.contact_first_name} onChange={set('contact_first_name')} required />
          </label>
          <label>
            {t('createNeed.phone')} * <input type="tel" value={form.contact_phone} onChange={set('contact_phone')} required />
          </label>
          <label>
            {t('createNeed.dateOfBirth')} * <input type="date" value={form.contact_date_of_birth} onChange={set('contact_date_of_birth')} required />
          </label>
          <label>
            {t('createNeed.email')} <input type="email" value={form.contact_email} onChange={set('contact_email')} />
          </label>
          <label>
            {t('createNeed.orgOrPerson')} <input type="text" value={form.organization_or_person_name} onChange={set('organization_or_person_name')} />
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
