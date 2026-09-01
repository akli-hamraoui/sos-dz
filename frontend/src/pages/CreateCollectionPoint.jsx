import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { isInAlgeria, reverseGeocodePlace } from '../utils'
import { translateApiError } from '../apiErrors'
import PlaceAutocomplete from '../components/PlaceAutocomplete'

const DEFAULT_FORM = { wilaya: '', point_name: '', contact_name: '', contact_phone: '', organization: '', location_description: '', hours: '' }

export default function CreateCollectionPoint() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { activeCampaignWilayas, wilayas, config } = useApp()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [gpsStatus, setGpsStatus] = useState(null) // null | 'locating' | 'error'
  const [error, setError] = useState('')

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
      const point = await api('/collection-points/', { method: 'POST', body: JSON.stringify(form) })
      navigate(`/collection-points/${point.id}`)
    } catch (err) {
      setError(translateApiError(err, t))
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
        <label>
          {t('collectionPoints.contactName')} * <input type="text" value={form.contact_name} onChange={set('contact_name')} required />
        </label>
        <label>
          {t('collectionPoints.contactPhone')} * <input type="tel" value={form.contact_phone} onChange={set('contact_phone')} required />
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
            required
          />
        </label>
        <label>
          {t('collectionPoints.hours')} <input type="text" value={form.hours} onChange={set('hours')} placeholder={t('collectionPoints.hoursPlaceholder')} />
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
