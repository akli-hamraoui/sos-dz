import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api, createOrQueue } from '../api'

const DEFAULT_FORM = {
  responder_type: 'individual_volunteer',
  content_brought: '',
  responder_last_name: '',
  responder_first_name: '',
  responder_phone: '',
  responder_date_of_birth: '',
  responder_email: '',
  organization_or_person_name: '',
}

export default function TakeCharge() {
  const { t } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const { savePickupToken, config } = useApp()
  const [need, setNeed] = useState(null)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [error, setError] = useState('')

  useEffect(() => {
    api(`/needs/${id}/`).then(setNeed).catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [id])

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    try {
      const fields = { ...form, need: id, turnstile_token: window.__turnstileToken || '' }
      const result = await createOrQueue({ type: 'pickup', endpoint: '/api/pickups/', fields })
      if (result.queued) {
        alert(t('offline.pendingSync'))
        navigate(`/needs/${id}`)
        return
      }
      savePickupToken(result.data.id, result.data.access_token)
      navigate(`/needs/${id}`)
    } catch (err) {
      setError((err.data && JSON.stringify(err.data)) || err.message)
    }
  }

  return (
    <section className="form-page">
      <h2>{t('takeCharge.title', { need: need ? need.title : '' })}</h2>
      <form onSubmit={submit}>
        <label>
          {t('takeCharge.type')} *
          <select value={form.responder_type} onChange={set('responder_type')} required>
            <option value="individual_volunteer">{t('takeCharge.individualVolunteer')}</option>
            <option value="organization">{t('takeCharge.organization')}</option>
            <option value="collective_truck">{t('takeCharge.collectiveTruck')}</option>
          </select>
        </label>
        <label>
          {t('takeCharge.whatBringing')} *
          <input type="text" value={form.content_brought} onChange={set('content_brought')} placeholder={t('takeCharge.whatBringingPlaceholder')} required />
        </label>
        <fieldset>
          <legend>{t('createNeed.contactDetailsLegend')}</legend>
          <label>
            {t('createNeed.lastName')} * <input type="text" value={form.responder_last_name} onChange={set('responder_last_name')} required />
          </label>
          <label>
            {t('createNeed.firstName')} * <input type="text" value={form.responder_first_name} onChange={set('responder_first_name')} required />
          </label>
          <label>
            {t('createNeed.phone')} * <input type="tel" value={form.responder_phone} onChange={set('responder_phone')} required />
          </label>
          <label>
            {t('createNeed.dateOfBirth')} * <input type="date" value={form.responder_date_of_birth} onChange={set('responder_date_of_birth')} required />
          </label>
          <label>
            {t('createNeed.email')} <input type="email" value={form.responder_email} onChange={set('responder_email')} />
          </label>
          <label>
            {t('createNeed.orgOrPerson')} <input type="text" value={form.organization_or_person_name} onChange={set('organization_or_person_name')} />
          </label>
        </fieldset>
        {config.turnstile_enabled && <div className="cf-turnstile" data-sitekey={config.turnstile_site_key} data-callback="onTurnstileToken" />}
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary">
          {t('takeCharge.confirmButton')}
        </button>
      </form>
    </section>
  )
}
