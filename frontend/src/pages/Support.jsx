import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../api'

export default function Support() {
  const { t } = useTranslation()
  const [form, setForm] = useState({ requester_phone: '', related_listing_description: '', message: '' })
  const [sent, setSent] = useState(false)

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    await api('/support-requests/', { method: 'POST', body: JSON.stringify(form) })
    setSent(true)
  }

  return (
    <section className="form-page">
      <h2>{t('support.title')}</h2>
      <p>{t('support.description')}</p>
      <form onSubmit={submit}>
        <label>
          {t('support.yourPhone')} * <input type="tel" value={form.requester_phone} onChange={set('requester_phone')} required />
        </label>
        <label>
          {t('support.relatedListing')} <input type="text" value={form.related_listing_description} onChange={set('related_listing_description')} />
        </label>
        <label>
          {t('support.message')} * <textarea value={form.message} onChange={set('message')} required />
        </label>
        <button type="submit" className="btn btn-primary">
          {t('support.send')}
        </button>
      </form>
      {sent && <p>{t('support.thanks')}</p>}
    </section>
  )
}
