import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../api'

export default function Support() {
  const { t } = useTranslation()
  const [form, setForm] = useState({ requester_phone: '', requester_email: '', related_listing_description: '', message: '' })
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.requester_phone.trim() && !form.requester_email.trim()) {
      setError(t('support.contactMethodRequired'))
      return
    }
    try {
      await api('/support-requests/', { method: 'POST', body: JSON.stringify({ ...form, category: 'general' }) })
      setSent(true)
    } catch (err) {
      setError((err.data && JSON.stringify(err.data)) || err.message)
    }
  }

  return (
    <section className="form-page">
      <h2>{t('support.title')}</h2>
      <p>{t('support.description')}</p>
      <form onSubmit={submit}>
        <label>
          {t('support.yourPhone')} ({t('common.optional')}) <input type="tel" value={form.requester_phone} onChange={set('requester_phone')} />
        </label>
        <label>
          {t('support.yourEmail')} ({t('common.optional')}) <input type="email" value={form.requester_email} onChange={set('requester_email')} />
        </label>
        <label>
          {t('support.relatedListing')} <input type="text" value={form.related_listing_description} onChange={set('related_listing_description')} />
        </label>
        <label>
          {t('support.message')} * <textarea value={form.message} onChange={set('message')} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary">
          {t('support.send')}
        </button>
      </form>
      {sent && <p>{t('support.thanks')}</p>}
      <p>
        <Link className="link" to="/report-bug">
          {t('support.reportBugLink')}
        </Link>
      </p>
    </section>
  )
}
