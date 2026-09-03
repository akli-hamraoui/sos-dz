import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useDialog } from '../context/DialogContext'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { maskPhone, googleMapsUrl } from '../utils'
import { translateApiError } from '../apiErrors'
import CommentThread from '../components/CommentThread'
import ModerationBadge from '../components/ModerationBadge'
import PickupManager from '../components/PickupManager'
import { IconFacebook, IconTikTok, IconInstagram, IconMapPin } from '../icons'

// Belt-and-suspenders on top of the server-side validation (which already
// only ever accepts/stores http(s) URLs, see core/validators.py): never
// render an <a href> for anything that isn't clearly http(s), regardless
// of where the value came from.
const isSafeHttpUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url)

const SOCIAL_NETWORKS = [
  { field: 'facebook_url', name: 'Facebook', Icon: IconFacebook },
  { field: 'tiktok_url', name: 'TikTok', Icon: IconTikTok },
  { field: 'instagram_url', name: 'Instagram', Icon: IconInstagram },
]

export default function CollectionPointDetail() {
  const { t } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const { showAlert, showPrompt } = useDialog()
  const { refreshConfig, pickupTokens } = useApp()
  const [cp, setCp] = useState(null)
  const [showPhone, setShowPhone] = useState(false)
  const [lightbox, setLightbox] = useState(null) // { src } for a full-size flyer preview

  const load = useCallback(async () => {
    setCp(await api(`/collection-points/${id}/`))
  }, [id])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  const reportFlyer = async () => {
    const reason = await showPrompt(t('needDetail.reportContent') + '?')
    if (!reason) return
    const reporter_name = (await showPrompt(t('createNeed.name') + ':')) || ''
    const reporter_phone = (await showPrompt(t('createNeed.phone') + ':')) || ''
    await api('/content-reports/', { method: 'POST', body: JSON.stringify({ media_type: 'collection_point_flyer', media_id: cp.id, reporter_name, reporter_phone, reason }) })
    load()
  }

  const closePoint = async () => {
    // Name+phone are optional at creation now -- a point created with a
    // recovery code instead has nothing to match against on the
    // name/phone path, so that's offered first and only falls back to
    // name+phone if left blank.
    const code = await showPrompt(t('collectionPoints.closePromptCode'))
    if (code === null) return
    let payload
    if (code.trim()) {
      payload = { code: code.trim() }
    } else {
      const contact_name = await showPrompt(t('collectionPoints.closePromptName'))
      if (!contact_name) return
      const contact_phone = await showPrompt(t('collectionPoints.closePromptPhone'))
      payload = { contact_name, contact_phone }
    }
    try {
      setCp(await api(`/collection-points/${id}/close/`, { method: 'POST', body: JSON.stringify(payload) }))
      refreshConfig()
    } catch (e) {
      showAlert(translateApiError(e, t))
    }
  }

  if (!cp) return null

  return (
    <section className="detail-page">
      <h2>{cp.point_name}</h2>
      <span className="status">{t(`status.${cp.status}`)}</span>
      <p>{cp.wilaya_name}</p>
      <p>{cp.location_description}</p>
      {cp.latitude != null && cp.longitude != null ? (
        <p>
          <a className="link field-label-icon" href={googleMapsUrl(cp.latitude, cp.longitude)} target="_blank" rel="noopener noreferrer">
            <IconMapPin width={16} height={16} strokeWidth={2} /> {t('common.openInMaps')}
          </a>
        </p>
      ) : (
        <p className="hint">{t('common.noExactGpsPosition')}</p>
      )}
      {cp.organization && <p>{cp.organization}</p>}
      {cp.hours && <p>{t('collectionPoints.hours')}: {cp.hours}</p>}
      {cp.accepted_donations && (
        <p className="multiline-text">
          {t('collectionPoints.acceptedDonationsLabel')}: {cp.accepted_donations}
        </p>
      )}

      {(cp.flyer_image || cp.flyer_moderation_status !== 'approved') && (
        <div>
          <ModerationBadge t={t} status={cp.flyer_moderation_status} moderatedBy={cp.flyer_moderated_by} />
          {!cp.flyer_image && (
            <p className="hint">
              {t('needDetail.recordedMessage', {
                status: cp.flyer_moderation_status === 'rejected' ? t('needDetail.removedByModeration') : t('needDetail.pendingReview'),
              })}
            </p>
          )}
          {cp.flyer_image && (
            <div>
              {/* A capped-size preview (click to view full-size in the
                  lightbox), not the full-bleed .media-player treatment
                  meant for video/audio -- a poster image doesn't need to
                  take up to 70vh of the page by default. */}
              <button type="button" className="flyer-thumb-btn" onClick={() => setLightbox({ src: cp.flyer_image })}>
                <img className="flyer-thumb" src={cp.flyer_image} alt="" />
              </button>
              <br />
              <button className="link" onClick={reportFlyer}>
                {t('needDetail.reportContent')}
              </button>
            </div>
          )}
        </div>
      )}
      <p>
        {t('needDetail.contact')}: {cp.contact_name} — {maskPhone(cp.contact_phone, showPhone)}{' '}
        <button className="link" onClick={() => setShowPhone(!showPhone)}>
          {showPhone ? t('common.hideNumber') : t('common.showFullNumber')}
        </button>
      </p>
      {/* other_phones is more personal contact info, same as contact_phone
          above -- kept behind the same reveal toggle instead of shown by
          default, rather than a separate always-visible field. */}
      {cp.other_phones && showPhone && (
        <p className="multiline-text">
          {t('collectionPoints.otherPhonesLabel')}: {cp.other_phones}
        </p>
      )}
      {cp.status === 'active' && (
        <button className="btn" onClick={closePoint}>
          {t('collectionPoints.markAsClosed')}
        </button>
      )}

      {cp.status === 'active' && (
        <>
          <h3>{t('needDetail.pickupsTitle', { count: cp.pickups.length })}</h3>
          <button className="btn btn-primary" onClick={() => navigate(`/collection-points/${id}/take-charge`)}>
            {t('collectionPoints.takeChargeDelivery')}
          </button>
        </>
      )}
      {cp.pickups.map((p) => (
        <PickupManager key={p.id} pickup={p} pickupToken={pickupTokens[p.id]} onChange={load} />
      ))}

      {SOCIAL_NETWORKS.some(({ field }) => isSafeHttpUrl(cp[field])) && (
        <div className="social-links-section">
          <h3>{t('collectionPoints.socialLinks')}</h3>
          <div className="social-links">
            {SOCIAL_NETWORKS.filter(({ field }) => isSafeHttpUrl(cp[field])).map(({ field, name, Icon }) => (
              <a
                key={field}
                href={cp[field]}
                target="_blank"
                rel="noopener noreferrer"
                className="social-link"
                aria-label={t('collectionPoints.visitSocial', { network: name })}
                title={t('collectionPoints.visitSocial', { network: name })}
              >
                <Icon width={22} height={22} />
              </a>
            ))}
          </div>
        </div>
      )}

      <CommentThread comments={cp.comments || []} target="collection_point" targetId={cp.id} onChanged={load} />

      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <button type="button" className="lightbox-close" onClick={() => setLightbox(null)} aria-label={t('needDetail.closeLightbox')}>
            ×
          </button>
          <img src={lightbox.src} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  )
}
