import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiUpload } from '../api'
import { translateApiError } from '../apiErrors'
import { IconCamera, IconCopy, IconReplay, IconTrash } from '../icons'
import '../urgent-sos-wizard-fixes.css'
import '../submit-flyer-wizard.css'

// Upload a flyer photo and let the backend's Gemini-vision pipeline
// (core.gemini_extraction) propose one or more collection points from it
// -- see core.models.FlyerSubmission. Every candidate point is
// auto-published as soon as extraction succeeds (core.views.
// FlyerSubmissionViewSet.create) -- no manual review step, so there's
// nothing for the submitter to confirm either: the wizard goes straight
// from the info step to the result.
//
// Presented as a 2-step wizard (photo / info) styled after the urgent-sos
// voice wizard (same .urgent-sos-* classes) but without any audio guide --
// see submit-flyer-wizard.css for the few scoped overrides (brand color
// instead of red, 2 columns instead of 4/5). No separate intro step -- the
// page title/kicker above already say what this does, so the wizard opens
// directly on the photo upload.
const S = { PHOTO: 0, INFO: 1 }

export default function SubmitFlyer() {
  const { t } = useTranslation()
  const [step, setStep] = useState(S.PHOTO)
  const [flyer, setFlyer] = useState(null) // { file, previewUrl } | null
  const [submitterName, setSubmitterName] = useState('')
  const [submitterPhone, setSubmitterPhone] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null)
  const [copied, setCopied] = useState(false)

  const go = (n) => {
    setError('')
    setStep(n)
  }

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

  const submit = async () => {
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

  const reset = () => {
    if (flyer) URL.revokeObjectURL(flyer.previewUrl)
    setFlyer(null)
    setSubmitterName('')
    setSubmitterPhone('')
    setError('')
    setResult(null)
    setStep(S.PHOTO)
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

  const stepLabels = [t('submitFlyer.stepPhoto'), t('submitFlyer.stepInfo')]
  const pi = result ? 1 : step
  const isDuplicateOnly = result?.status === 'rejected' && result.rejection_reason === 'duplicate'
  const isDone = result && (result.status === 'published' || isDuplicateOnly)
  const isRejectedNonDuplicate = result?.status === 'rejected' && !isDuplicateOnly

  return (
    <section className="urgent-sos-page submit-flyer-wizard">
      <div className="urgent-sos-shell">
        <div className="urgent-sos-kicker">
          📸 {t('submitFlyer.kicker')}
        </div>
        <div className="urgent-sos-hero">
          <div className="urgent-sos-icon">
            <IconCamera width={30} height={30} />
          </div>
          <div>
            <h1>{t('submitFlyer.title')}</h1>
            <p>{t('submitFlyer.intro')}</p>
          </div>
        </div>
        <div className="urgent-sos-stepper">
          {stepLabels.map((x, i) => (
            <div key={x} className={i <= pi ? 'done' : ''} data-current={i === pi}>
              <span>{i + 1}</span>
              <small>{x}</small>
            </div>
          ))}
        </div>
        <div className="urgent-sos-progress">
          {[0, 1].map((i) => (
            <span key={i} className={i <= pi ? 'active' : ''} />
          ))}
        </div>

        {step === S.PHOTO && !result && (
          <div className="urgent-sos-card">
            <h2>{t('submitFlyer.flyerLabel')}</h2>
            <p>{t('submitFlyer.flyerHint')}</p>
            {flyer ? (
              <div className="flyer-photo-thumbs">
                <div className="flyer-photo-thumb">
                  <img src={flyer.previewUrl} alt="" />
                  <button type="button" className="flyer-remove-photo" onClick={removeFlyer} aria-label={t('common.delete')}>
                    <IconTrash width={14} height={14} strokeWidth={2} />
                  </button>
                </div>
              </div>
            ) : (
              <label className="btn photo-add-btn flyer-add-photo">
                <IconCamera width={18} height={18} strokeWidth={1.6} /> {t('submitFlyer.flyerAdd')}
                <input type="file" accept="image/*" onChange={addFlyer} hidden />
              </label>
            )}
            <div className="urgent-sos-actions">
              <button type="button" className="urgent-sos-primary" disabled={!flyer} onClick={() => go(S.INFO)}>
                {t('urgentSos.continue')}
              </button>
            </div>
          </div>
        )}

        {step === S.INFO && !result && (
          <div className="urgent-sos-card">
            <h2>{t('submitFlyer.infoStepTitle')}</h2>
            <p>{t('submitFlyer.submitterHint')}</p>
            <div className="urgent-sos-fields">
              <label>
                {t('submitFlyer.submitterName')}
                <input type="text" value={submitterName} onChange={(e) => setSubmitterName(e.target.value)} />
              </label>
              <label>
                {t('submitFlyer.submitterPhone')}
                <input type="tel" value={submitterPhone} onChange={(e) => setSubmitterPhone(e.target.value)} />
              </label>
            </div>
            {error && <p className="urgent-sos-error">{error}</p>}
            <div className="urgent-sos-actions">
              <button type="button" className="urgent-sos-secondary" onClick={() => go(S.PHOTO)} disabled={submitting}>
                {t('urgentSos.previous')}
              </button>
              <button type="button" className="urgent-sos-primary" onClick={submit} disabled={submitting} aria-busy={submitting}>
                {submitting && <span className="flyer-btn-spinner" aria-hidden="true" />}
                {submitting ? t('submitFlyer.submitting') : t('submitFlyer.submit')}
              </button>
            </div>
          </div>
        )}

        {result && (
          <div className="urgent-sos-card urgent-sos-done-card">
            <div className={`urgent-sos-final-badge${isDone ? '' : ' is-error'}`}>
              {isDone ? `✓ ${t('submitFlyer.doneTitle')}` : `⚠ ${t('submitFlyer.notDoneTitle')}`}
            </div>
            <h2>{result.status === 'published' ? t('submitFlyer.createdTitle') : t('submitFlyer.title')}</h2>
            {(result.status === 'published' || isDuplicateOnly) && (
              <>
                {result.status === 'published' ? (
                  <p className="success">
                    {t('submitFlyer.resultPublished', { count: result.extracted_points.filter((p) => p.is_published).length })}
                  </p>
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
            {isRejectedNonDuplicate && <p className="error">{t(rejectionMessageKey[result.rejection_reason] || 'submitFlyer.rejectedGeneric')}</p>}
            {result.status === 'failed' && <p className="error">{t('submitFlyer.resultFailed')}</p>}
            {result.status === 'processing' && <p>{t('submitFlyer.resultProcessing')}</p>}
            {isDone ? (
              <div className="urgent-sos-actions">
                <button type="button" className="urgent-sos-secondary" onClick={reset}>
                  {t('submitFlyer.submitAnother')}
                </button>
                <Link className="urgent-sos-secondary" to="/collection-points/create">
                  {t('submitFlyer.useManualForm')}
                </Link>
              </div>
            ) : (
              <div className="urgent-sos-actions flyer-error-actions">
                <button type="button" className="urgent-sos-primary" onClick={reset}>
                  <IconReplay width={18} height={18} /> {t('submitFlyer.submitAnother')}
                </button>
                <Link className="flyer-ghost-link" to="/collection-points/create">
                  {t('submitFlyer.useManualForm')}
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
