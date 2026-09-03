import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api, createOrQueue } from '../api'
import { translateApiError } from '../apiErrors'
import { validityMessageProps } from '../utils'

const DEFAULT_FORM = {
  responder_type: 'individual_volunteer',
  content_brought: '',
  responder_name: '',
  responder_phone: '',
  responder_email: '',
  organization_or_person_name: '',
  recovery_code: '',
}

// source: 'need' (default) or 'collection_point' -- same Pickup model and
// endpoint either way, just linked via a different field and returning to
// a different detail page. See core/models.py Pickup: exactly one of
// need/collection_point is ever set on a given pickup.
export default function TakeCharge({ source = 'need' }) {
  const { t } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const { savePickupToken, config, refreshConfig } = useApp()
  const { showAlert } = useDialog()
  const validityProps = validityMessageProps(t)
  const [target, setTarget] = useState(null)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [error, setError] = useState('')

  const detailPath = source === 'collection_point' ? `/collection-points/${id}` : `/needs/${id}`
  const targetLabel = source === 'collection_point' ? target?.point_name : target?.title

  useEffect(() => {
    const endpoint = source === 'collection_point' ? `/collection-points/${id}/` : `/needs/${id}/`
    api(endpoint).then(setTarget).catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [id, source])

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

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
            {t('takeCharge.phoneLabel')} * <input type="tel" value={form.responder_phone} onChange={set('responder_phone')} required {...validityProps} />
          </label>
          <label>
            {t('createNeed.email')} <input type="email" value={form.responder_email} onChange={set('responder_email')} {...validityProps} />
          </label>
          <label>
            {t('createNeed.orgOrPerson')} <input type="text" value={form.organization_or_person_name} onChange={set('organization_or_person_name')} />
          </label>
        </fieldset>
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
