import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { maskPhone } from '../utils'
import { translateApiError } from '../apiErrors'
import CommentThread from '../components/CommentThread'

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

      <CommentThread comments={cp.comments || []} target="collection_point" targetId={cp.id} onChanged={load} />
    </section>
  )
}
