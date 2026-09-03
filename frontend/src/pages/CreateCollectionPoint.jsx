import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api, apiUpload } from '../api'
import { isInAlgeria, reverseGeocodePlace } from '../utils'
import { translateApiError } from '../apiErrors'
import PlaceAutocomplete from '../components/PlaceAutocomplete'
import { IconFacebook, IconTikTok, IconInstagram, IconCamera, IconTrash } from '../icons'

const DEFAULT_FORM = {
  wilaya: '',
  point_name: '',
  contact_name: '',
  contact_phone: '',
  recovery_code: '',
  other_phones: '',
  organization: '',
  location_description: '',
  hours: '',
  accepted_donations: '',
  facebook_url: '',
  tiktok_url: '',
  instagram_url: '',
}

export default function CreateCollectionPoint() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { activeCampaignWilayas, wilayas, config, refreshConfig } = useApp()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [gpsStatus, setGpsStatus] = useState(null) // null | 'locating' | 'error'
  const [error, setError] = useState('')
  const [flyer, setFlyer] = useState(null) // { file, previewUrl } | null

  const addFlyer = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setFlyer({ file, previewUrl: URL.createObjectURL(file) })
  }

  const removeFlyer = () => {
    if (flyer) URL.revokeObjectURL(flyer.previewUrl)
    setFlyer(null)
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setGpsStatus('error')
      return
    }
    setGpsStatus('locating')
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        let { latitude, longitude } = pos.coords
        // See CreateNeed.jsx for why: an admin testing from outside
        // Algeria gets Algiers instead of a "coordinates outside
        // Algeria" error on submit.
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
          /* best-effort */
        }
        try {
          const place = await reverseGeocodePlace(latitude, longitude, i18n.language)
          if (place) setForm((f) => ({ ...f, location_description: place }))
        } catch {
          /* best-effort only -- the field just stays whatever it already was */
        }
      },
      () => setGpsStatus('error'),
      { timeout: 8000 }
    )
  }

  const clearLocation = () => {
    setGpsStatus(null)
    setForm((f) => ({ ...f, latitude: null, longitude: null }))
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    try {
      const formData = new FormData()
      Object.entries(form).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '') formData.append(k, v)
      })
      if (flyer) formData.append('flyer_image', flyer.file, flyer.file.name || 'flyer.jpg')
      const point = await apiUpload('/collection-points/', formData)
      refreshConfig()
      navigate(`/collection-points/${point.id}`)
    } catch (err) {
      // Temporary diagnostic: a raw client-side failure (thrown before/
      // instead of a proper API error -- network down, an unhandled JS
      // exception, etc.) has no translated message and falls back to the
      // generic apology, which hides the actual cause. Admins get the raw
      // status/message appended so a bug can be diagnosed from a phone
      // with no access to browser devtools.
      const friendly = translateApiError(err, t)
      setError(config.is_admin ? `${friendly} [debug: status=${err.status ?? 'none'} message="${err.message}"]` : friendly)
    }
  }

  return (
    <section className="form-page">
      <h2>{t('collectionPoints.createTitle')}</h2>
      <form onSubmit={submit}>
        <label>
          {t('createNeed.wilaya')} *
          <select value={form.wilaya} onChange={set('wilaya')} required>
            <option value="">{t('createNeed.selectPlaceholder')}</option>
            {activeCampaignWilayas.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('collectionPoints.pointName')} * <input type="text" value={form.point_name} onChange={set('point_name')} required />
        </label>
        <p className="hint">{t('createNeed.contactDetailsHint')}</p>
        <label>
          {t('collectionPoints.contactName')} <input type="text" value={form.contact_name} onChange={set('contact_name')} />
        </label>
        <label>
          {t('collectionPoints.contactPhone')} <input type="tel" value={form.contact_phone} onChange={set('contact_phone')} />
        </label>
        <label>
          {t('collectionPoints.otherPhones')}
          <textarea rows={3} value={form.other_phones} onChange={set('other_phones')} placeholder={t('collectionPoints.otherPhonesPlaceholder')} />
        </label>
        <label>
          {t('createNeed.recoveryCode')}{' '}
          <input type="text" value={form.recovery_code} onChange={set('recovery_code')} placeholder={t('createNeed.recoveryCodePlaceholder')} minLength={6} />
          <span className="hint">{t('createNeed.recoveryCodeHint')}</span>
        </label>
        <label>
          {t('collectionPoints.organization')} <input type="text" value={form.organization} onChange={set('organization')} />
        </label>
        <label>
          {t('collectionPoints.locationDescription')} *
          <PlaceAutocomplete
            as="textarea"
            value={form.location_description}
            onChange={(v) => setForm((f) => ({ ...f, location_description: v }))}
            onSelectPlace={({ lat, lon }) => {
              setGpsStatus(null)
              setForm((f) => ({ ...f, latitude: lat, longitude: lon }))
            }}
            required
          />
        </label>
        <label>
          {t('collectionPoints.hours')} <input type="text" value={form.hours} onChange={set('hours')} placeholder={t('collectionPoints.hoursPlaceholder')} />
        </label>
        <label>
          {t('collectionPoints.acceptedDonations')}
          <textarea rows={3} value={form.accepted_donations} onChange={set('accepted_donations')} placeholder={t('collectionPoints.acceptedDonationsPlaceholder')} />
        </label>
        <div>
          {t('collectionPoints.flyer')}
          <p className="hint">{t('collectionPoints.flyerHint')}</p>
          {flyer ? (
            <div className="photo-thumbs">
              <div className="photo-thumb">
                <img src={flyer.previewUrl} alt="" />
                <button type="button" className="link" onClick={removeFlyer}>
                  <IconTrash width={14} height={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          ) : (
            <label className="btn photo-add-btn">
              <IconCamera width={18} height={18} strokeWidth={1.6} /> {t('collectionPoints.flyerAdd')}
              <input type="file" accept="image/*" onChange={addFlyer} hidden />
            </label>
          )}
        </div>
        <label>
          <span className="field-label-icon">
            <IconFacebook width={18} height={18} strokeWidth={1.6} /> {t('collectionPoints.facebook')}
          </span>
          <input type="url" value={form.facebook_url} onChange={set('facebook_url')} placeholder={t('collectionPoints.facebookPlaceholder')} />
        </label>
        <label>
          <span className="field-label-icon">
            <IconTikTok width={18} height={18} strokeWidth={1.6} /> {t('collectionPoints.tiktok')}
          </span>
          <input type="url" value={form.tiktok_url} onChange={set('tiktok_url')} placeholder={t('collectionPoints.tiktokPlaceholder')} />
        </label>
        <label>
          <span className="field-label-icon">
            <IconInstagram width={18} height={18} strokeWidth={1.6} /> {t('collectionPoints.instagram')}
          </span>
          <input type="url" value={form.instagram_url} onChange={set('instagram_url')} placeholder={t('collectionPoints.instagramPlaceholder')} />
        </label>
        <div className="gps-controls">
          <button type="button" className="btn" onClick={useMyLocation} disabled={gpsStatus === 'locating'}>
            {t('createNeed.useMyLocation')}
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
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary">
          {t('collectionPoints.publish')}
        </button>
      </form>
    </section>
  )
}
