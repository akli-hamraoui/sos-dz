import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { maskPhone } from '../utils'
import { translateApiError } from '../apiErrors'
import CommentThread from '../components/CommentThread'
import { IconFacebook, IconTikTok, IconInstagram } from '../icons'

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
  const { showAlert, showPrompt } = useDialog()
  const [cp, setCp] = useState(null)
  const [showPhone, setShowPhone] = useState(false)

  const load = useCallback(async () => {
    setCp(await api(`/collection-points/${id}/`))
  }, [id])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  const closePoint = async () => {
    const contact_name = await showPrompt(t('collectionPoints.closePromptName'))
    if (!contact_name) return
    const contact_phone = await showPrompt(t('collectionPoints.closePromptPhone'))
    try {
      setCp(await api(`/collection-points/${id}/close/`, { method: 'POST', body: JSON.stringify({ contact_name, contact_phone }) }))
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
      {cp.latitude == null && <p className="hint">{t('common.noExactGpsPosition')}</p>}
      {cp.organization && <p>{cp.organization}</p>}
      {cp.hours && <p>{t('collectionPoints.hours')}: {cp.hours}</p>}
      <p>
        {t('needDetail.contact')}: {cp.contact_name} — {maskPhone(cp.contact_phone, showPhone)}{' '}
        <button className="link" onClick={() => setShowPhone(!showPhone)}>
          {showPhone ? t('common.hideNumber') : t('common.showFullNumber')}
        </button>
      </p>
      {cp.status === 'active' && (
        <button className="btn" onClick={closePoint}>
          {t('collectionPoints.markAsClosed')}
        </button>
      )}

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
    </section>
  )
}
