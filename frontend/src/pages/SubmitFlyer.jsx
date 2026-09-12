import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiUpload } from '../api'
import { translateApiError } from '../apiErrors'
import { IconCamera, IconCopy, IconTrash } from '../icons'

// Upload a flyer photo and let the backend's Gemini-vision pipeline
// (core.gemini_extraction) propose one or more collection points from it
// -- see core.models.FlyerSubmission. Nothing here is published directly:
// every result is either a hard rejection (no country found on the flyer,
// or it mentions an online money-collection method) or a "needs_review"
// submission waiting on a human volunteer, same as the manual form's own
// flyer moderation queue.
export default function SubmitFlyer() {
  const { t } = useTranslation()
  const [flyer, setFlyer] = useState(null) // { file, previewUrl } | null
  const [submitterName, setSubmitterName] = useState('')
  const [submitterPhone, setSubmitterPhone] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)

  const [copied, setCopied] = useState(false)

  const copyTrackingCode = async (code) => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch {
      /* best-effort only -- no clipboard permission/API, the code is still shown as plain text */
    }
  }

  const addFlyer = (e) => {
    const file = e.target.files[0]
    if (!file) return
    setFlyer({ file, previewUrl: URL.createObjectURL(file) })
  }

  const removeFlyer = () => {
    if (flyer) URL.revokeObjectURL(flyer.previewUrl)
    setFlyer(null)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!flyer) return
    setError('')
    setSubmitting(true)
    try {
      const formData = new FormData()
      formData.append('flyer_image', flyer.file, flyer.file.name || 'flyer.jpg')
      if (submitterName) formData.append('submitter_name', submitterName)
      if (submitterPhone) formData.append('submitter_phone', submitterPhone)
      const data = await apiUpload('/flyer-submissions/', formData)
      setResult(data)
    } catch (err) {
      setError(translateApiError(err, t))
    } finally {
      setSubmitting(false)
    }
  }

  const rejectionMessageKey = {
    no_country: 'submitFlyer.rejectedNoCountry',
    money_collection: 'submitFlyer.rejectedMoneyCollection',
    flyer_moderation: 'submitFlyer.rejectedModeration',
    admin: 'submitFlyer.rejectedAdmin',
    duplicate: 'submitFlyer.rejectedDuplicate',
  }

  const pointsList = (points) => (
    <div className="needs-list">
      {points.map((p) => (
        <div key={p.id} className="need-card">
          <strong>{p.point_name}</strong> — {p.city || p.wilaya_name || p.country_name}
          {p.duplicate_of ? (
            <p className="hint">
              {t('submitFlyer.duplicateSkipped')}{' '}
              <Link to={`/collection-points/${p.duplicate_of}`}>{p.duplicate_of_name}</Link>
            </p>
          ) : (
            <p className="hint">
              {t('submitFlyer.publishedNow')}{' '}
              {p.is_published && <Link to={`/collection-points/${p.published_point}`}>{t('common.open')}</Link>}
            </p>
          )}
        </div>
      ))}
    </div>
  )

  if (result) {
    return (
      <section className="form-page">
        <h2>{t('submitFlyer.title')}</h2>
        {(result.status === 'published' || (result.status === 'rejected' && result.rejection_reason === 'duplicate')) && (
          <>
            {result.status === 'published' ? (
              <p className="success">{t('submitFlyer.resultPublished', { count: result.extracted_points.filter((p) => p.is_published).length })}</p>
            ) : (
              <p className="error">{t('submitFlyer.rejectedDuplicate')}</p>
            )}
            {pointsList(result.extracted_points)}
            {result.status === 'published' && (
              <div className="urgent-sos-token-box">
                <div className="urgent-sos-token-title">{t('submitFlyer.trackingCode')}</div>
                <div className="urgent-sos-token-row">
                  <strong className="urgent-sos-token">{result.access_token}</strong>
                  <button
                    type="button"
                    className="urgent-sos-copy-token"
                    onClick={() => copyTrackingCode(result.access_token)}
                    aria-label={copied ? t('common.copied') : t('common.copy')}
                    title={copied ? t('common.copied') : t('common.copy')}
                  >
                    {copied ? '✓' : <IconCopy width={17} height={17} />}
                    <span className="urgent-sos-copy-label">{copied ? t('common.copied') : t('common.copy')}</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {result.status === 'rejected' && result.rejection_reason !== 'duplicate' && (
          <p className="error">{t(rejectionMessageKey[result.rejection_reason] || 'submitFlyer.rejectedGeneric')}</p>
        )}
        {result.status === 'failed' && <p className="error">{t('submitFlyer.resultFailed')}</p>}
        {result.status === 'processing' && <p>{t('submitFlyer.resultProcessing')}</p>}
        <div className="gps-controls">
          <button
            type="button"
            className="btn"
            onClick={() => {
              removeFlyer()
              setResult(null)
            }}
          >
            {t('submitFlyer.submitAnother')}
          </button>
          <Link className="link" to="/collection-points/create">
            {t('submitFlyer.useManualForm')}
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section className="form-page">
      <h2>{t('submitFlyer.title')}</h2>
      <p className="hint">{t('submitFlyer.intro')}</p>
      <form onSubmit={submit}>
        <div>
          {t('submitFlyer.flyerLabel')} *
          <p className="hint">{t('submitFlyer.flyerHint')}</p>
          {flyer ? (
            <div className="photo-thumbs">
              <div className="photo-thumb">
                <img src={flyer.previewUrl} alt="" />
                <button type="button" className="link" onClick={removeFlyer}>
                  <IconTrash width={14} height={14} strokeWidth={2} />
                </button>
              </div>
            </div>
          ) : (
            <label className="btn photo-add-btn">
              <IconCamera width={18} height={18} strokeWidth={1.6} /> {t('submitFlyer.flyerAdd')}
              <input type="file" accept="image/*" onChange={addFlyer} required hidden />
            </label>
          )}
        </div>
        <p className="hint">{t('submitFlyer.submitterHint')}</p>
        <label>
          {t('submitFlyer.submitterName')} <input type="text" value={submitterName} onChange={(e) => setSubmitterName(e.target.value)} />
        </label>
        <label>
          {t('submitFlyer.submitterPhone')} <input type="tel" value={submitterPhone} onChange={(e) => setSubmitterPhone(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn btn-primary" disabled={!flyer || submitting}>
          {submitting ? t('submitFlyer.submitting') : t('submitFlyer.submit')}
        </button>
      </form>
    </section>
  )
}
