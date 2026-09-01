import { useState } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'

export default function Recover() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { saveNeedToken, savePickupToken } = useApp()
  const { showAlert } = useDialog()
  const recoverContext = location.state // { type: 'need'|'pickup', id }
  const [useCode, setUseCode] = useState(true)
  const [form, setForm] = useState({ code: '', name: '', phone: '' })
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
    const payload = useCode ? { code: form.code } : { name: form.name, phone: form.phone }
    try {
      const result = await api(`/${type === 'need' ? 'needs' : 'pickups'}/${id}/recover-access/`, { method: 'POST', body: JSON.stringify(payload) })
      if (type === 'need') {
        saveNeedToken(id, { access_token: result.access_token })
        navigate(`/needs/${id}`)
      } else {
        savePickupToken(id, result.access_token)
        showAlert(t('recover.recoverButton') + ' ✓')
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
        {useCode ? (
          <label>
            {t('createNeed.recoveryCode')} * <input type="text" value={form.code} onChange={set('code')} required />
          </label>
        ) : (
          <>
            <label>
              {t('createNeed.name')} * <input type="text" value={form.name} onChange={set('name')} required />
            </label>
            <label>
              {t('createNeed.phone')} * <input type="tel" value={form.phone} onChange={set('phone')} required />
            </label>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary">
          {t('recover.recoverButton')}
        </button>
      </form>
      <button type="button" className="link" onClick={() => setUseCode((v) => !v)}>
        {useCode ? t('recover.forgotCode') : t('recover.useCodeInstead')}
      </button>
      <br />
      <Link className="link" to="/support">
        {t('recover.stillNotWorking')}
      </Link>
    </section>
  )
}
