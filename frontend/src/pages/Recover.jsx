import { useState } from 'react'
import { useLocation, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { translateApiError } from '../apiErrors'
import { validityMessageProps } from '../utils'

export default function Recover() {
  const { t } = useTranslation()
  const location = useLocation()
  const navigate = useNavigate()
  const { saveNeedToken, savePickupToken, saveCpToken } = useApp()
  const validityProps = validityMessageProps(t)
  const recoverContext = location.state // { type: 'need'|'pickup'|'collection_point', id }
  const [useCode, setUseCode] = useState(true)
  const [form, setForm] = useState({ code: '', name: '', phone: '' })
  const [error, setError] = useState('')

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }))

  const RESOURCE_PATHS = { need: 'needs', pickup: 'pickups', collection_point: 'collection-points' }

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    const { type, id } = recoverContext
    const payload = useCode ? { code: form.code } : { name: form.name, phone: form.phone }
    try {
      const result = await api(`/${RESOURCE_PATHS[type]}/${id}/recover-access/`, { method: 'POST', body: JSON.stringify(payload) })
      if (type === 'need') {
        saveNeedToken(id, { access_token: result.access_token })
        navigate(`/needs/${id}`)
      } else if (type === 'collection_point') {
        saveCpToken(id, result.access_token)
        navigate(`/collection-points/${id}`)
      } else {
        savePickupToken(id, result.access_token)
        // Recovering a pickup's access must land back on a page that shows
        // its owner controls (share-location toggle, mark delivered,
        // anonymize), not leave the courier stranded on this form with
        // just a toast -- its own dedicated page (PickupDetail) shows all
        // of that plus a link back to the parent need/collection point.
        navigate(`/pickups/${id}`)
      }
    } catch (err) {
      setError(translateApiError(err, t))
    }
  }

  // This page only makes sense reached from a specific need/pickup's own
  // "Is this yours? Recover access" link (which carries the id via router
  // state) -- there's no global "look up by code" lookup, by design (see
  // check_recovery_code_available: a code is only ever checked against
  // one specific listing, never searched for across all of them). Landed
  // here without that context (e.g. a bookmarked/typed URL, or "the link"
  // was lost) -- point back to finding the listing itself instead of a
  // dead-end form, since the listing's own page is just its normal public
  // URL, always reachable again via search/browse.
  if (!recoverContext) {
    return (
      <section className="form-page">
        <h2>{t('recover.title')}</h2>
        <p>{t('recover.noContextHint')}</p>
        <Link className="btn btn-primary" to="/needs">
          {t('nav.needs')}
        </Link>
      </section>
    )
  }

  return (
    <section className="form-page">
      <h2>{t('recover.title')}</h2>
      <p>{t('recover.description')}</p>
      <form onSubmit={submit}>
        {useCode ? (
          <label>
            {t('recover.codeLabel')} * <input type="text" value={form.code} onChange={set('code')} required {...validityProps} />
          </label>
        ) : (
          <>
            <label>
              {t('recover.nameLabel')} * <input type="text" value={form.name} onChange={set('name')} required {...validityProps} />
            </label>
            <label>
              {t('recover.phoneLabel')} * <input type="tel" value={form.phone} onChange={set('phone')} required {...validityProps} />
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
