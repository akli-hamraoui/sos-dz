import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { haversineKm } from '../utils'

export default function CollectionPoints() {
  const { t } = useTranslation()
  const { wilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [points, setPoints] = useState([])
  // Always defaults to the map on every visit -- see NeedsList.jsx for why
  // this is deliberately not persisted.
  const [viewMode, setViewMode] = useState('map')
  const [mapHasNothing, setMapHasNothing] = useState(false)
  const mapRef = useRef(null)
  const mapElRef = useRef(null)
  const markersRef = useRef([])

  const load = useCallback(async () => {
    const qs = filterWilaya ? `?wilaya=${filterWilaya}` : ''
    const data = await api(`/collection-points/${qs}`)
    setPoints(data.results || data)
  }, [filterWilaya])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  const smartZoom = (map, mapPoints, wilayaId) => {
    if (wilayaId) {
      const selected = wilayas.find((w) => String(w.id) === String(wilayaId))
      if (mapPoints.length === 0) {
        if (selected && selected.centroid_latitude != null) {
          map.setView([selected.centroid_latitude, selected.centroid_longitude], 10)
        } else {
          map.setView([28.0, 2.6], 5)
        }
        return
      }
      map.fitBounds(L.latLngBounds(mapPoints).pad(0.3), { maxZoom: 12 })
      return
    }
    if (mapPoints.length === 0) {
      map.setView([28.0, 2.6], 5)
      return
    }
    const doZoom = (userLatLng) => {
      const nearby = userLatLng ? mapPoints.filter((pt) => haversineKm(userLatLng, pt) <= 50) : []
      const target = nearby.length ? nearby : mapPoints
      const bounds = L.latLngBounds(target)
      map.fitBounds(bounds.pad(0.3), { maxZoom: nearby.length ? 11 : 6 })
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => doZoom([pos.coords.latitude, pos.coords.longitude]),
        () => doZoom(null),
        { timeout: 3000 }
      )
    } else {
      doZoom(null)
    }
  }

  useEffect(() => {
    if (viewMode !== 'map') return
    let cancelled = false

    ;(async () => {
      let cpPins
      const qs = filterWilaya ? `?wilaya=${filterWilaya}` : ''
      try {
        cpPins = await api(`/collection-points/locations/${qs}`)
      } catch {
        return // offline/network failure -- offline banner already informs the user
      }
      if (cancelled) return
      setMapHasNothing(cpPins.length === 0)

      requestAnimationFrame(() => {
        if (!mapElRef.current) return
        if (!mapRef.current) {
          mapRef.current = L.map(mapElRef.current)
          L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
            maxZoom: 17,
          }).addTo(mapRef.current)
        }
        const map = mapRef.current
        markersRef.current.forEach((m) => map.removeLayer(m))
        const markers = []

        const cpsWithPos = cpPins.filter((p) => p.display_latitude != null && p.display_longitude != null)
        cpsWithPos.forEach((p) => {
          const icon = L.divIcon({ className: 'cp-marker-icon', html: '■', iconSize: [16, 16] })
          const marker = L.marker([p.display_latitude, p.display_longitude], { icon }).addTo(map)
          const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
          marker.bindPopup(
            `<strong>${p.point_name}</strong><br>${p.contact_name}${p.organization ? '<br>' + p.organization : ''}` +
              `${p.hours ? '<br>' + p.hours : ''}<br>${p.wilaya_name}${gpsNote}<br><a href="/collection-points/${p.id}">${t('common.open')}</a>`
          )
          markers.push(marker)
        })

        markersRef.current = markers
        const allPoints = cpsWithPos.map((p) => [p.display_latitude, p.display_longitude])
        smartZoom(map, allPoints, filterWilaya)
      })
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, filterWilaya])

  return (
    <section className="needs-page">
      <div className="toolbar">
        <label>
          {t('needsList.filterByWilaya')}
          <select value={filterWilaya} onChange={(e) => setFilterWilaya(e.target.value)}>
            <option value="">{t('needsList.all')}</option>
            {wilayas.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <div className="view-toggle">
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
            {t('needsList.list')}
          </button>
          <button className={viewMode === 'map' ? 'active' : ''} onClick={() => setViewMode('map')}>
            {t('needsList.map')}
          </button>
        </div>
        <Link className="btn btn-primary" to="/collection-points/create">
          {t('collectionPoints.addButton')}
        </Link>
      </div>

      {viewMode === 'list' && (
        <>
          {points.length === 0 && <p>{t('collectionPoints.noPointsYet')}</p>}
          <div className="needs-list">
            {points.map((cp) => (
              <Link className="need-card" to={`/collection-points/${cp.id}`} key={cp.id}>
                <h3>{cp.point_name}</h3>
                <p>
                  {cp.wilaya_name}
                  {cp.organization ? ' — ' + cp.organization : ''}
                </p>
                <p className="status">{cp.status === 'closed' ? t('status.closed') : cp.hours || t('collectionPoints.hoursNotSpecified')}</p>
              </Link>
            ))}
          </div>
        </>
      )}

      {viewMode === 'map' && (
        <div className="map-wrap">
          {mapHasNothing && <p className="hint">{t('collectionPoints.noPointsYet')}</p>}
          <div id="cp-map" ref={mapElRef} style={{ height: 500 }} />
        </div>
      )}
    </section>
  )
}
