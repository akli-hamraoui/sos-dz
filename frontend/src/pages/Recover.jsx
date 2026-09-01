import { useState } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api } from '../api'

export default function Recover() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { saveNeedToken, savePickupToken } = useApp()
  const recoverContext = location.state // { type: 'need'|'pickup', id }
  const [form, setForm] = useState({ name: '', phone: '' })
  const [error, setError] = useState('')

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!recoverContext) {
      setError('Open this from a need/pickup page first.')
      return
    }
    const { type, id } = recoverContext
    try {
      const result = await api(`/${type === 'need' ? 'needs' : 'pickups'}/${id}/recover-access/`, { method: 'POST', body: JSON.stringify(form) })
      if (type === 'need') {
        saveNeedToken(id, { access_token: result.access_token })
        navigate(`/needs/${id}`)
      } else {
        savePickupToken(id, result.access_token)
        alert(t('recover.recoverButton') + ' ✓')
      }
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <section className="form-page">
      <h2>{t('recover.title')}</h2>
      <p>{t('recover.description')}</p>
      <form onSubmit={submit}>
        <label>
          {t('createNeed.name')} * <input type="text" value={form.name} onChange={set('name')} required />
        </label>
        <label>
          {t('createNeed.phone')} * <input type="tel" value={form.phone} onChange={set('phone')} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary">
          {t('recover.recoverButton')}
        </button>
      </form>
      <Link className="link" to="/support">
        {t('recover.stillNotWorking')}
      </Link>
    </section>
  )
}
