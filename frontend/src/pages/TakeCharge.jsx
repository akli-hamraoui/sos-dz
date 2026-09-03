import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api, createOrQueue } from '../api'
import { translateApiError } from '../apiErrors'
import { validityMessageProps, reverseGeocodePlace } from '../utils'
import PlaceAutocomplete from '../components/PlaceAutocomplete'
import { IconMapPin } from '../icons'

const DEFAULT_FORM = {
  responder_type: 'individual_volunteer',
  content_brought: '',
  responder_name: '',
  responder_phone: '',
  responder_email: '',
  organization_or_person_name: '',
  recovery_code: '',
  departure_description: '',
  departure_latitude: null,
  departure_longitude: null,
}

// source: 'need' (default) or 'collection_point' -- same Pickup model and
// endpoint either way, just linked via a different field and returning to
// a different detail page. See core/models.py Pickup: exactly one of
// need/collection_point is ever set on a given pickup.
export default function TakeCharge({ source = 'need' }) {
  const { t, i18n } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const { savePickupToken, config, refreshConfig } = useApp()
  const { showAlert } = useDialog()
  const validityProps = validityMessageProps(t)
  const [target, setTarget] = useState(null)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [error, setError] = useState('')
  const [gpsStatus, setGpsStatus] = useState(null) // null | 'locating' | 'error'

  const detailPath = source === 'collection_point' ? `/collection-points/${id}` : `/needs/${id}`
  const targetLabel = source === 'collection_point' ? target?.point_name : target?.title
  const targetDescription = target?.location_description

  useEffect(() => {
    const endpoint = source === 'collection_point' ? `/collection-points/${id}/` : `/needs/${id}/`
    api(endpoint).then(setTarget).catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [id, source])

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  // Optional "use my current position" shortcut for the departure field --
  // same navigator.geolocation.getCurrentPosition + reverse-geocode
  // pattern as CreateNeed's own "Ma position" button, just without that
  // page's admin-outside-Algeria fallback (not relevant here: a courier
  // declaring where they're starting from is expected to actually be
  // there). Never invents coordinates from typed text alone -- see
  // PlaceAutocomplete's onSelectPlace below for the other way coordinates
  // get set.
  const useMyDepartureLocation = () => {
    if (!navigator.geolocation) {
      setGpsStatus('error')
      return
    }
    setGpsStatus('locating')
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords
        setGpsStatus(null)
        setForm((f) => ({ ...f, departure_latitude: latitude, departure_longitude: longitude }))
        try {
          const label = await reverseGeocodePlace(latitude, longitude, i18n.language)
          if (label) setForm((f) => (f.departure_description ? f : { ...f, departure_description: label }))
        } catch {
          /* best-effort label only -- coordinates are already captured either way */
        }
      },
      () => setGpsStatus('error'),
      { enableHighAccuracy: true, timeout: 15000 }
    )
  }

  const clearDeparturePosition = () => setForm((f) => ({ ...f, departure_latitude: null, departure_longitude: null }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    try {
      const fields = { ...form, [source]: id, turnstile_token: window.__turnstileToken || '' }
      const result = await createOrQueue({ type: 'pickup', endpoint: '/api/pickups/', fields })
      if (result.queued) {
        showAlert(t('offline.pendingSync'))
        navigate(detailPath)
        return
      }
      savePickupToken(result.data.id, result.data.access_token)
      refreshConfig()
      navigate(detailPath)
    } catch (err) {
      setError(translateApiError(err, t))
    }
  }

  return (
    <section className="form-page">
      <h2>{t('takeCharge.title', { need: targetLabel || '' })}</h2>
      {target && (
        <div className="pickup-card">
          <p className="status">
            {t('takeCharge.resourceType')}:{' '}
            {source === 'collection_point' ? t('needsList.collectionPointLabel') : t('takeCharge.resourceTypeNeed')}
          </p>
          <p>
            <strong>{targetLabel}</strong>
          </p>
          {targetDescription && <p>{targetDescription}</p>}
          <Link className="link" to={detailPath}>
            {source === 'collection_point' ? t('takeCharge.viewCollectionPointDetail') : t('takeCharge.viewNeedDetail')}
          </Link>
        </div>
      )}
      <form onSubmit={submit}>
        <label>
          {t('takeCharge.type')} *
          <select value={form.responder_type} onChange={set('responder_type')} required {...validityProps}>
            <option value="individual_volunteer">{t('takeCharge.individualVolunteer')}</option>
            <option value="organization">{t('takeCharge.organization')}</option>
            <option value="collective_truck">{t('takeCharge.collectiveTruck')}</option>
          </select>
        </label>
        <label>
          {t('takeCharge.whatBringing')} *
          <input type="text" value={form.content_brought} onChange={set('content_brought')} placeholder={t('takeCharge.whatBringingPlaceholder')} required {...validityProps} />
        </label>
        <fieldset>
          <legend>{t('createNeed.contactDetailsLegend')}</legend>
          <label>
            {t('takeCharge.nameLabel')} * <input type="text" value={form.responder_name} onChange={set('responder_name')} required {...validityProps} />
          </label>
          <label>
            {t('takeCharge.phoneLabel')} ({t('common.optional')}) <input type="tel" value={form.responder_phone} onChange={set('responder_phone')} {...validityProps} />
          </label>
          <label>
            {t('createNeed.email')} <input type="email" value={form.responder_email} onChange={set('responder_email')} {...validityProps} />
          </label>
          <label>
            {t('createNeed.orgOrPerson')} <input type="text" value={form.organization_or_person_name} onChange={set('organization_or_person_name')} />
          </label>
        </fieldset>
        <label>
          {t('takeCharge.departureLocation')} ({t('common.optional')})
          <PlaceAutocomplete
            value={form.departure_description}
            onChange={(v) => setForm((f) => ({ ...f, departure_description: v }))}
            onSelectPlace={({ lat, lon }) => setForm((f) => ({ ...f, departure_latitude: lat, departure_longitude: lon }))}
            placeholder={t('takeCharge.departureLocationPlaceholder')}
          />
          <span className="hint">{t('takeCharge.departureLocationHint')}</span>
        </label>
        <button type="button" className="btn btn-icon" onClick={useMyDepartureLocation} disabled={gpsStatus === 'locating'}>
          <IconMapPin width={16} height={16} strokeWidth={2} /> {t('createNeed.useMyLocation')}
        </button>
        {gpsStatus === 'locating' && <p className="hint">{t('createNeed.gpsLocating')}</p>}
        {gpsStatus === 'error' && <p className="error">{t('createNeed.gpsError')}</p>}
        {form.departure_latitude != null && (
          <p className="hint field-label-icon">
            <IconMapPin width={16} height={16} strokeWidth={2} />
            {t('takeCharge.departurePositionCaptured')}{' '}
            <button type="button" className="link" onClick={clearDeparturePosition}>
              {t('takeCharge.clearDeparturePosition')}
            </button>
          </p>
        )}
        <label>
          {t('createNeed.recoveryCode')}{' '}
          <input type="text" value={form.recovery_code} onChange={set('recovery_code')} placeholder={t('createNeed.recoveryCodePlaceholder')} minLength={6} {...validityProps} />
          <span className="hint">{t('createNeed.recoveryCodeHint')}</span>
        </label>
        {config.turnstile_enabled && <div className="cf-turnstile" data-sitekey={config.turnstile_site_key} data-callback="onTurnstileToken" />}
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary">
          {t('takeCharge.confirmButton')}
        </button>
      </form>
    </section>
  )
}
