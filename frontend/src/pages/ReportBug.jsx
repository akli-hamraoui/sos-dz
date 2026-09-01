import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { translateApiError } from '../apiErrors'

export default function ReportBug() {
  const { t } = useTranslation()
  const [form, setForm] = useState({ requester_phone: '', requester_email: '', message: '' })
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    try {
      await api('/support-requests/', { method: 'POST', body: JSON.stringify({ ...form, category: 'bug' }) })
      setSent(true)
    } catch (err) {
      setError(translateApiError(err, t))
    }
  }

  return (
    <section className="form-page">
      <h2>{t('reportBug.title')}</h2>
      <p>{t('reportBug.description')}</p>
      <form onSubmit={submit}>
        <label>
          {t('reportBug.message')} * <textarea value={form.message} onChange={set('message')} placeholder={t('reportBug.messagePlaceholder')} required />
        </label>
        <label>
          {t('support.yourPhone')} ({t('common.optional')}) <input type="tel" value={form.requester_phone} onChange={set('requester_phone')} />
        </label>
        <label>
          {t('support.yourEmail')} ({t('common.optional')}) <input type="email" value={form.requester_email} onChange={set('requester_email')} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary">
          {t('support.send')}
        </button>
      </form>
      {sent && <p>{t('reportBug.thanks')}</p>}
      <p>
        <Link className="link" to="/support">
          {t('reportBug.contactAdminLink')}
        </Link>
      </p>
    </section>
  )
}
