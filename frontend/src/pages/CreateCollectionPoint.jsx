import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api } from '../api'

const DEFAULT_FORM = { wilaya: '', point_name: '', contact_name: '', contact_phone: '', organization: '', location_description: '', hours: '' }

export default function CreateCollectionPoint() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { wilayas } = useApp()
  const [form, setForm] = useState(DEFAULT_FORM)
  const [error, setError] = useState('')

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const useMyLocation = () => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(async (pos) => {
      setForm((f) => ({ ...f, latitude: pos.coords.latitude, longitude: pos.coords.longitude }))
      try {
        const suggestion = await api(`/wilayas/nearest/?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`)
        setForm((f) => (f.wilaya ? f : { ...f, wilaya: suggestion.id }))
      } catch {
        /* best-effort */
      }
    })
  }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    try {
      const point = await api('/collection-points/', { method: 'POST', body: JSON.stringify(form) })
      navigate(`/collection-points/${point.id}`)
    } catch (err) {
      setError((err.data && JSON.stringify(err.data)) || err.message)
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
            {wilayas.map((w) => (
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
          {t('collectionPoints.locationDescription')} * <textarea value={form.location_description} onChange={set('location_description')} required />
        </label>
        <label>
          {t('collectionPoints.hours')} <input type="text" value={form.hours} onChange={set('hours')} placeholder={t('collectionPoints.hoursPlaceholder')} />
        </label>
        <button type="button" className="btn" onClick={useMyLocation}>
          {t('createNeed.useMyLocation')}
        </button>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary">
          {t('collectionPoints.publish')}
        </button>
      </form>
    </section>
  )
}
