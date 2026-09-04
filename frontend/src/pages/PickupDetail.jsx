import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import CommentThread from '../components/CommentThread'
import PickupManager from '../components/PickupManager'

// A pickup/delivery's own dedicated page -- recovering access to one (see
// Recover.jsx) lands here, same idea as a Need/CollectionPoint's own detail
// page. Reuses PickupManager (the exact card already shown inline on the
// parent Need/CollectionPoint page) for the actual status/timeline/photos/
// live-sharing/mark-delivered UI, rather than duplicating that logic --
// this page only adds the "what is this a delivery for" framing and the
// link back to the parent's own detail page.
export default function PickupDetail() {
  const { t } = useTranslation()
  const { id } = useParams()
  const { pickupTokens } = useApp()
  const [pickup, setPickup] = useState(null)
  const [notFound, setNotFound] = useState(false)

  const load = useCallback(async () => {
    try {
      setPickup(await api(`/pickups/${id}/`))
    } catch {
      setNotFound(true)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  if (notFound) {
    return (
      <section className="detail-page">
        <p>{t('pickupDetail.notFound')}</p>
      </section>
    )
  }

  if (!pickup) return null

  const isCollectionPoint = !!pickup.collection_point
  const targetLabel = isCollectionPoint ? pickup.collection_point_name : pickup.need_title
  const targetWilaya = isCollectionPoint ? pickup.collection_point_wilaya_name : pickup.need_wilaya_name
  const detailPath = isCollectionPoint ? `/collection-points/${pickup.collection_point}` : `/needs/${pickup.need}`

  return (
    <section className="detail-page">
      <h2>{t('pickupDetail.title')}</h2>
      <p>
        {t('takeCharge.resourceType')}: {isCollectionPoint ? t('needsList.collectionPointLabel') : t('takeCharge.resourceTypeNeed')}
      </p>
      {targetLabel && (
        <p>
          <strong>{targetLabel}</strong>
          {targetWilaya ? ` — ${targetWilaya}` : ''}
        </p>
      )}
      <Link className="link" to={detailPath}>
        {isCollectionPoint ? t('takeCharge.viewCollectionPointDetail') : t('takeCharge.viewNeedDetail')}
      </Link>
      {/* Same public position data already shown on the aggregate
          Transporteurs map (Deliveries.jsx) -- a plain coordinates line
          here rather than embedding a second map, since that map already
          exists and is one click away via the nav. Nothing rendered at
          all when there's no live ping or declared departure point. */}
      {pickup.current_position && (
        <p className="status">
          {t('pickupDetail.currentPosition')}: {pickup.current_position.latitude.toFixed(4)}, {pickup.current_position.longitude.toFixed(4)}{' '}
          {pickup.current_position.is_live ? `(${t('deliveries.liveMarkerLabel')})` : `(${t('deliveries.departureMarkerLabel')})`}
        </p>
      )}

      <PickupManager pickup={pickup} pickupToken={pickupTokens[id]} onChange={load} />

      <CommentThread comments={pickup.comments || []} target="pickup" targetId={pickup.id} onChanged={load} />
    </section>
  )
}
