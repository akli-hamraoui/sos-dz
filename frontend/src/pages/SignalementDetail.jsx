import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { translateApiError } from '../apiErrors'
import { useDialog } from '../context/DialogContext'
import { formatDate, googleMapsDirectionsUrl } from '../utils'
import CommentThread from '../components/CommentThread'
import CopyButton from '../components/CopyButton'
import PhotoLightbox from '../components/PhotoLightbox'
import SignaliAiNotice from '../components/SignaliAiNotice'
import { categoryEmoji, getSignalementToken, saveSignalementToken, SIGNALI_CATEGORIES, SIGNALI_STATUSES } from '../signali'
import '../signali.css'

// One Signali report: its photos, video, description, voice note and
// transcripts, a Google Maps itinerary, citizens' votes and comments --
// and, for its reporter, the management code (the access token shown
// right after sending) to copy, then use to change its status, edit or
// cancel it (SignalementViewSet.manage).

function ManagePanel({ s, token, justCreated, onChange, onForget }) {
  const { t } = useTranslation()
  const { showConfirm } = useDialog()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [description, setDescription] = useState(s.description || '')
  const [category, setCategory] = useState(s.category)

  const manage = async (body, done) => {
    setBusy(true)
    setMessage('')
    try {
      const updated = await api(`/signalements/${s.id}/manage/`, {
        method: 'POST',
        headers: { 'X-Access-Token': token },
        body: JSON.stringify(body),
      })
      onChange(updated)
      setMessage(done)
    } catch (e) {
      setMessage(translateApiError(e, t))
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (status) => {
    if (status === 'cancelled' && !(await showConfirm(t('signali.cancelConfirm')))) return
    manage({ status }, t('signali.statusSaved'))
  }

  return (
    <section className={`signali-manage${justCreated ? ' is-new' : ''}`}>
      <h2>🔐 {t('signali.manageTitle')}</h2>
      <p className="signali-manage-warning">{t('signali.tokenWarning')}</p>
      <div className="signali-token-row">
        <code>{token}</code>
        <CopyButton text={token} className="btn" />
      </div>

      <div className="signali-label">{t('signali.changeStatus')}</div>
      <div className="signali-status-buttons">
        {SIGNALI_STATUSES.map((st) => (
          <button key={st} type="button" className={s.status === st ? 'selected' : ''} onClick={() => setStatus(st)} disabled={busy || s.status === st}>
            {t(`signali.status.${st}`)}
          </button>
        ))}
      </div>

      <label className="signali-label" htmlFor="signali-edit-category">{t('signali.categoryLabel')}</label>
      <select id="signali-edit-category" value={category} onChange={(e) => setCategory(e.target.value)}>
        {SIGNALI_CATEGORIES.map((c) => (
          <option key={c} value={c}>{categoryEmoji(c)} {t(`signali.categories.${c}`)}</option>
        ))}
      </select>
      <label className="signali-label" htmlFor="signali-edit-description">{t('signali.textLabel')}</label>
      <textarea id="signali-edit-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
      <div className="signali-detail-actions">
        <button type="button" className="btn btn-primary" onClick={() => manage({ description, category }, t('signali.saved'))} disabled={busy}>
          {t('common.save')}
        </button>
        <button type="button" className="btn" onClick={onForget}>{t('signali.forgetCode')}</button>
      </div>
      {message && <p className="signali-message" role="status">{message}</p>}
    </section>
  )
}

function UnlockWithCode({ id, onUnlocked }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')

  const check = async () => {
    setError('')
    try {
      // An empty manage call only checks the code.
      await api(`/signalements/${id}/manage/`, { method: 'POST', headers: { 'X-Access-Token': code.trim() }, body: '{}' })
      saveSignalementToken(id, code.trim())
      onUnlocked(code.trim())
    } catch (e) {
      setError(e?.status === 403 ? t('signali.codeInvalid') : translateApiError(e, t))
    }
  }

  if (!open) {
    return (
      <button type="button" className="signali-link signali-unlock-link" onClick={() => setOpen(true)}>
        🔐 {t('signali.haveCode')}
      </button>
    )
  }
  return (
    <div className="signali-unlock">
      <label htmlFor="signali-code">{t('signali.enterCode')}</label>
      <div className="signali-coords-row">
        <input id="signali-code" type="text" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" />
        <button type="button" className="btn btn-primary" onClick={check} disabled={!code.trim()}>{t('common.confirm')}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

export default function SignalementDetail() {
  const { id } = useParams()
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const justCreated = !!location.state?.justCreated
  const mediaWarnings = location.state?.mediaWarnings || []
  const [agreed, setAgreed] = useState(false)
  const [s, setS] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [lightbox, setLightbox] = useState(null)
  const [token, setToken] = useState(() => getSignalementToken(id))

  const load = useCallback(async () => {
    try {
      // With its code, the author also sees photos/video still awaiting review.
      const code = getSignalementToken(id)
      setS(await api(`/signalements/${id}/`, { headers: code ? { 'X-Access-Token': code } : {} }))
      setError('')
    } catch (e) {
      setError(translateApiError(e, t))
    }
  }, [id, t])

  useEffect(() => {
    load()
  }, [load])

  const vote = async (path, done) => {
    setBusy(true)
    setMessage('')
    try {
      setS(await api(`/signalements/${id}/${path}/`, { method: 'POST', headers: token ? { 'X-Access-Token': token } : {} }))
      setMessage(done)
    } catch (e) {
      setMessage(translateApiError(e, t))
    } finally {
      setBusy(false)
    }
  }

  const forget = () => {
    saveSignalementToken(id, null)
    setToken(null)
  }

  if (error) return <section className="signalements-page"><p className="error">{error}</p></section>
  if (!s) return <section className="signalements-page"><p>{t('common.loading')}</p></section>

  const pending = s.processing_status === 'pending'
  const open = s.status === 'new' || s.status === 'in_review'
  const transcripts = [s.voice_transcript, s.video_transcript].filter((x) => x && x.trim())
  const photos = s.photos.filter((p) => p.image)

  return (
    <section className="signalements-page signalement-detail-page">
      {/* Only right after sending: one short notice (sent + AI check). */}
      {justCreated &&
        (pending ? (
          <SignaliAiNotice sent />
        ) : (
          <div className="signali-created" role="status">
            <strong>✓ {t('signali.createdTitle')}</strong>
          </div>
        ))}
      {justCreated && mediaWarnings.length > 0 && <p className="signali-media-warning" role="status">⚠️ {t('signali.mediaWarning')}</p>}
      {token && justCreated && <ManagePanel s={s} token={token} justCreated onChange={setS} onForget={forget} />}

      <article className="signali-detail">
        <header>
          <span className="signali-detail-emoji" aria-hidden="true">{categoryEmoji(s.category)}</span>
          <div>
            <h1>{t(`signali.categories.${s.category}`)}</h1>
            <small>{[s.address, s.commune, s.wilaya_name].filter(Boolean).join(', ')}</small>
            {/* Under the title, never over it. */}
            <span className={`signali-status is-${pending ? 'pending' : s.status}`}>
              {pending ? t('signali.statusPending') : t(`signali.status.${s.status}`)}
            </span>
          </div>
        </header>
        {!s.has_exact_position && <p className="signali-pending-note">📍 {t('signali.noExactPosition')}</p>}

        {(photos.length > 0 || s.video_file) && (
          <div className="signali-detail-media">
            {photos.map((p) => (
              <button type="button" key={p.id} onClick={() => setLightbox(p.image)} className="signali-detail-photo">
                <img src={p.image} alt={t('common.photoAlt')} loading="lazy" />
              </button>
            ))}
            {s.video_file && <video src={s.video_file} controls playsInline preload="metadata" />}
          </div>
        )}
        {!pending && !photos.length && !s.video_file && <p className="signali-pending-note">{t('signali.mediaUnderReview')}</p>}

        {s.description && (
          <>
            <h2 className="signali-section-title">{t('signali.descriptionHeading')}</h2>
            <p className="signali-detail-text">{s.description}</p>
          </>
        )}
        {s.voice_file && (
          <>
            <h2 className="signali-section-title">🎙️ {t('signali.voiceLabel')}</h2>
            <audio src={s.voice_file} controls preload="none" />
          </>
        )}
        {transcripts.map((x, i) => (
          <blockquote key={i} className="signali-transcript">📝 {x}</blockquote>
        ))}

        <div className="signali-detail-meta">
          <span>{formatDate(s.created_at, i18n.language)}</span>
          {s.category_suggested_by_ai && <span>✨ {t('signali.aiCategory')}</span>}
          {s.fixed_reports_count > 0 && open && <span>🔧 {t('signali.fixedCount', { count: s.fixed_reports_count })}</span>}
        </div>

        <div className="signali-detail-actions">
          <a className="btn btn-primary" href={googleMapsDirectionsUrl(s.display_latitude, s.display_longitude)} target="_blank" rel="noreferrer">
            🧭 {t('signali.itinerary')}
          </a>
          <Link className="btn" to={`/signalements?focus=${s.id}`}>🗺️ {t('signali.viewOnMap')}</Link>
        </div>
        <div className="signali-detail-actions">
          {/* "I agree / still there": one per person (IP), the count goes up
              right away. The reporter counts as the first one. */}
          <button
            type="button"
            className={`btn signali-agree${agreed ? ' is-done' : ''}`}
            onClick={() => vote('confirm', t('signali.thanksConfirm')).then(() => setAgreed(true))}
            disabled={busy || agreed || !open || pending}
          >
            👍 {t('signali.agree')} <b>{s.confirmations_count + 1}</b>
          </button>
        </div>
        {open && !pending && (
          <div className="signali-detail-actions">
            {!token && (
              <button type="button" className="btn" onClick={() => vote('report-fixed', t('signali.thanksFixed'))} disabled={busy}>🔧 {t('signali.itsFixed')}</button>
            )}
          </div>
        )}
        {message && <p className="signali-message" role="status">{message}</p>}
      </article>

      {token && !justCreated && <ManagePanel s={s} token={token} onChange={setS} onForget={forget} />}
      {!token && <UnlockWithCode id={s.id} onUnlocked={setToken} />}

      <CommentThread comments={s.comments || []} target="signalement" targetId={s.id} onChanged={load} notice={t('signali.commentIpNotice')} />
      <PhotoLightbox src={lightbox} onClose={() => setLightbox(null)} />
    </section>
  )
}
