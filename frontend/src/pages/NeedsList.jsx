import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api, loadJSON, saveJSON } from '../api'
import { urgencyColor, haversineKm } from '../utils'
import { IconBox } from '../icons'

function statusLabel(t, s) {
  return t(`status.${s}`, s)
}

export default function NeedsList() {
  const { t } = useTranslation()
  const { wilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [needs, setNeeds] = useState([])
  const [viewMode, setViewMode] = useState(() => loadJSON('rassemble_view_mode', 'list'))
  const [mapHasNothing, setMapHasNothing] = useState(false)
  const mapRef = useRef(null)
  const mapElRef = useRef(null)
  const markersRef = useRef([])

  const loadNeeds = useCallback(async () => {
    const qs = filterWilaya ? `?wilaya=${filterWilaya}` : ''
    const data = await api(`/needs/${qs}`)
    setNeeds(data.results || data)
  }, [filterWilaya])

  useEffect(() => {
    loadNeeds().catch(() => {}) // offline/network failure -- offline banner already informs the user, nothing more to do here
  }, [loadNeeds])

  const setMode = (mode) => {
    setViewMode(mode)
    saveJSON('rassemble_view_mode', mode)
  }

  const smartZoom = (map, points) => {
    if (points.length === 0) {
      map.setView([28.0, 2.6], 5)
      return
    }
    const doZoom = (userLatLng) => {
      const nearby = userLatLng ? points.filter((pt) => haversineKm(userLatLng, pt) <= 50) : []
      const target = nearby.length ? nearby : points
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
      let needPins, cpPins
      try {
        ;[needPins, cpPins] = await Promise.all([api('/needs/locations/'), api('/collection-points/locations/').catch(() => [])])
      } catch {
        return // offline/network failure -- offline banner already informs the user
      }
      if (cancelled) return
      const hasNothing = needPins.length === 0 && cpPins.length === 0
      setMapHasNothing(hasNothing)
      if (hasNothing) return

      requestAnimationFrame(() => {
        if (!mapElRef.current) return
        if (!mapRef.current) {
          mapRef.current = L.map(mapElRef.current)
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(mapRef.current)
        }
        const map = mapRef.current
        markersRef.current.forEach((m) => map.removeLayer(m))
        const markers = []

        const needsWithPos = needPins.filter((p) => p.display_latitude != null && p.display_longitude != null)
        needsWithPos.forEach((p) => {
          const marker = L.circleMarker([p.display_latitude, p.display_longitude], {
            radius: 9,
            color: urgencyColor(p.urgency),
            fillColor: urgencyColor(p.urgency),
            fillOpacity: 0.85,
          }).addTo(map)
          const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
          marker.bindPopup(
            `<strong>${p.title}</strong><br>${p.urgency} — ${p.wilaya_name}<br>${(p.location_description || '').slice(0, 80)}` +
              `<br>${statusLabel(t, p.overall_status)}${gpsNote}<br><a href="/needs/${p.id}">${t('common.open')}</a>`
          )
          markers.push(marker)
        })

        const cpsWithPos = cpPins.filter((p) => p.display_latitude != null && p.display_longitude != null)
        cpsWithPos.forEach((p) => {
          const icon = L.divIcon({ className: 'cp-marker-icon', html: '■', iconSize: [16, 16] })
          const marker = L.marker([p.display_latitude, p.display_longitude], { icon }).addTo(map)
          const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
          const boxIconSvg =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z"/>' +
            '<path d="M3.5 7.5 12 12l8.5-4.5"/><path d="M12 12v9"/></svg>'
          marker.bindPopup(
            `<strong>${boxIconSvg} ${p.point_name}</strong><br>${p.contact_name}${p.organization ? '<br>' + p.organization : ''}` +
              `${p.hours ? '<br>' + p.hours : ''}<br>${p.wilaya_name}${gpsNote}<br><a href="/collection-points/${p.id}">${t('common.open')}</a>`
          )
          markers.push(marker)
        })

        markersRef.current = markers
        const allPoints = needsWithPos.map((p) => [p.display_latitude, p.display_longitude]).concat(cpsWithPos.map((p) => [p.display_latitude, p.display_longitude]))
        smartZoom(map, allPoints)
      })
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])

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
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>
            {t('needsList.list')}
          </button>
          <button className={viewMode === 'map' ? 'active' : ''} onClick={() => setMode('map')}>
            {t('needsList.map')}
          </button>
        </div>
      </div>

      {viewMode === 'list' && (
        <div className="needs-list">
          {needs.length === 0 && <p>{t('needsList.noActiveNeeds')}</p>}
          {needs.map((n) => (
            <Link className="need-card" to={`/needs/${n.id}`} key={n.id}>
              <span className={`badge urgency-${n.urgency}`}>{t(`urgency.${n.urgency}`)}</span>
              <h3>{n.title}</h3>
              <p>
                {n.wilaya_name}
                {n.commune ? ' — ' + n.commune : ''}
              </p>
              <p className="status">
                {statusLabel(t, n.overall_status)} — {t('needsList.pickupsCount', { count: n.pickups.length })}
              </p>
            </Link>
          ))}
        </div>
      )}

      {viewMode === 'map' && (
        <div className="map-wrap">
          {mapHasNothing && <p className="hint">{t('needsList.noActiveNeeds')}</p>}
          {!mapHasNothing && <div id="main-map" ref={mapElRef} style={{ height: 500 }} />}
          {!mapHasNothing && (
            <div className="legend">
              <span className="legend-item">
                <span className="legend-dot" style={{ background: urgencyColor('critical') }} />
                {t('urgency.critical')}
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: urgencyColor('medium') }} />
                {t('urgency.medium')}
              </span>
              <span className="legend-item">
                <span className="legend-dot" style={{ background: urgencyColor('low') }} />
                {t('urgency.low')}
              </span>
              <span className="legend-item">
                <IconBox width={14} height={14} strokeWidth={2} />
                {t('needsList.collectionPointLabel')}
              </span>
              <span className="legend-note">{t('needsList.legendNote')}</span>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
