import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { apiUpload } from '../api'
import { validityMessageProps } from '../utils'
import { translateApiError } from '../apiErrors'
import { countryOptions } from '../countries'
import PlaceAutocomplete from '../components/PlaceAutocomplete'
import CountrySelect from '../components/CountrySelect'
import { IconFacebook, IconTikTok, IconInstagram, IconCamera, IconTrash, IconMapPin } from '../icons'

// International counterpart to CreateCollectionPoint.jsx -- same fields
// and identity/close logic (contact name/phone or recovery code, flyer,
// social links), minus wilaya (replaced with a country picker) and minus
// anything related to couriers/take-charge, which this kind of point never
// offers (see CollectionPointDetail.jsx and Pickup's own server-side
// rejection of a delivery targeting an international point).
const DEFAULT_FORM = {
  country_code: '',
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
  latitude: null,
  longitude: null,
}

// Exact match with CollectionPointCreateSerializer.validate's own message
// (backend/core/serializers.py) -- this one case gets a real <Link> to the
// national create page rather than plain translated text, so it's special-
// cased here instead of going through apiErrors.js's string-only matchers.
const ALGERIA_POSITION_MESSAGE = 'This position is in Algeria. Please use the national collection points page instead.'

export default function CreateInternationalCollectionPoint() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { config, saveCpToken } = useApp()
  const validityProps = validityMessageProps(t)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [gpsStatus, setGpsStatus] = useState(null) // null | 'locating' | 'error'
  const [error, setError] = useState('') // string | 'ALGERIA_POSITION'
  const [flyer, setFlyer] = useState(null) // { file, previewUrl } | null

  const countries = countryOptions(i18n.language)

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
      (pos) => {
        setGpsStatus(null)
        setForm((f) => ({ ...f, latitude: pos.coords.latitude, longitude: pos.coords.longitude }))
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
      const country = countries.find((c) => c.code === form.country_code)
      const formData = new FormData()
      Object.entries(form).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '') formData.append(k, v)
      })
      if (country) formData.append('country_name', country.name)
      if (flyer) formData.append('flyer_image', flyer.file, flyer.file.name || 'flyer.jpg')
      const point = await apiUpload('/collection-points/', formData)
      saveCpToken(point.id, point.access_token)
      navigate(`/collection-points/${point.id}`)
    } catch (err) {
      if (err.data?.latitude?.[0] === ALGERIA_POSITION_MESSAGE) {
        setError('ALGERIA_POSITION')
        return
      }
      const friendly = translateApiError(err, t)
      setError(config.is_admin ? `${friendly} [debug: status=${err.status ?? 'none'} message="${err.message}"]` : friendly)
    }
  }

  return (
    <section className="form-page">
      <h2>{t('internationalCollectionPoints.createTitle')}</h2>
      <p className="hint">
        <Link className="link field-label-icon" to="/collection-points/create">
          🇩🇿 {t('internationalCollectionPoints.goToNationalLink')}
        </Link>
      </p>
      <form onSubmit={submit}>
        <label>
          {t('internationalCollectionPoints.country')} *
          <CountrySelect
            value={form.country_code}
            onChange={(code) => setForm((f) => ({ ...f, country_code: code }))}
            lang={i18n.language}
            placeholder={t('createNeed.selectPlaceholder')}
            required
            onInvalid={validityProps.onInvalid}
          />
        </label>
        <label>
          {t('collectionPoints.pointName')} * <input type="text" value={form.point_name} onChange={set('point_name')} required {...validityProps} />
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
            countryCode={form.country_code || 'any'}
            required
            onInvalid={validityProps.onInvalid}
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
          <button type="button" className="btn btn-icon" onClick={useMyLocation} disabled={gpsStatus === 'locating'}>
            <IconMapPin width={16} height={16} strokeWidth={2} /> {t('createNeed.useMyLocation')}
          </button>
          {(gpsStatus === 'error' || form.latitude) && (
            <button type="button" className="link" onClick={clearLocation}>
              {t('createNeed.clearGps')}
            </button>
          )}
        </div>
        <p className="hint">{t('internationalCollectionPoints.exactPositionRequired')}</p>
        {gpsStatus === 'locating' && <p className="hint">{t('createNeed.gpsLocating')}</p>}
        {gpsStatus === 'error' && <p className="error">{t('createNeed.gpsError')}</p>}
        {form.latitude && !gpsStatus && <p>{t('createNeed.gpsCaptured', { lat: form.latitude, lon: form.longitude })}</p>}
        {error === 'ALGERIA_POSITION' ? (
          <p className="error">
            {t('internationalCollectionPoints.positionInAlgeria')}{' '}
            <Link className="link" to="/collection-points/create">
              {t('internationalCollectionPoints.positionInAlgeriaLink')}
            </Link>
          </p>
        ) : (
          error && <p className="error">{error}</p>
        )}

        {/* Contact/identity fields last, same convention as every other
            form in the app (CreateNeed.jsx, TakeCharge.jsx) -- useful only
            for managing/closing this listing later, not for finding it, so
            it doesn't need to compete with the actually-descriptive fields
            above for a reporter's attention. */}
        <fieldset>
          <legend>{t('createNeed.contactDetailsLegend')}</legend>
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
            <input type="text" value={form.recovery_code} onChange={set('recovery_code')} placeholder={t('createNeed.recoveryCodePlaceholder')} minLength={6} {...validityProps} />
            <span className="hint">{t('createNeed.recoveryCodeHint')}</span>
          </label>
        </fieldset>

        <button type="submit" className="btn btn-primary">
          {t('collectionPoints.publish')}
        </button>
      </form>
    </section>
  )
}
