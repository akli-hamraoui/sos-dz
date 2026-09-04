import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { truckIcon } from '../mapMarkers'
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
  const mapElRef = useRef(null)

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

  const position = pickup?.current_position

  // A small map zoomed on the transporter's own position (live ping if
  // location sharing is on, else their declared departure point -- see
  // Pickup.latest_known_position) instead of the previous plain lat/lon
  // text line. Nothing rendered at all when there's no position, same as
  // before.
  useEffect(() => {
    if (!position || !mapElRef.current) return
    const map = L.map(mapElRef.current, {
      attributionControl: false,
      gestureHandling: true,
      gestureHandlingOptions: {
        text: { touch: t('map.gestureTouch'), scroll: t('map.gestureScroll'), scrollMac: t('map.gestureScrollMac') },
      },
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map)
    L.control.attribution({ prefix: false }).addTo(map)
    const point = [position.latitude, position.longitude]
    L.marker(point, { icon: truckIcon(L, position.is_live) }).addTo(map)
    map.setView(point, 15)
    return () => map.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.latitude, position?.longitude, position?.is_live])

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
          Transporteurs map (Deliveries.jsx), zoomed on this one transporter
          instead of a plain coordinates line. Nothing rendered at all when
          there's no live ping or declared departure point. */}
      {position && (
        <>
          <p className="status">{position.is_live ? t('deliveries.liveMarkerLabel') : t('deliveries.departureMarkerLabel')}</p>
          <div className="map-wrap">
            <div id="pickup-detail-map" ref={mapElRef} style={{ height: 260 }} />
          </div>
        </>
      )}

      <PickupManager pickup={pickup} pickupToken={pickupTokens[id]} onChange={load} />
    </section>
  )
}
