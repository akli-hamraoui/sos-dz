import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { urgencyColor, haversineKm, isInAlgeria, getCurrentPosition, RECENTER_BOX_METERS } from '../utils'
import { needIcon, collectionPointIcon, needPopupHtml, collectionPointPopupHtml } from '../mapMarkers'
import { IconLocate } from '../icons'

function statusLabel(t, s) {
  return t(`status.${s}`, s)
}

// The combined "Je veux aider" page: unlike NeedsList.jsx (SOS/Besoins
// only, see that file) and CollectionPoints.jsx (collection points only),
// this page deliberately shows both together -- someone who wants to help
// doesn't yet know whether they'll end up responding to a need or dropping
// off at a collection point, so it puts both choices side by side instead
// of making them pick a category first. No "J'ai besoin d'aide" entry
// point here -- that's the other half of Home's pair of CTAs, not this one.
export default function Help() {
  const { t } = useTranslation()
  const { activeCampaignWilayas } = useApp()
  const { showAlert } = useDialog()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [needs, setNeeds] = useState([])
  const [collectionPoints, setCollectionPoints] = useState([])
  const [viewMode, setViewMode] = useState('map')
  const [mapHasNothing, setMapHasNothing] = useState(false)
  const mapRef = useRef(null)
  const mapElRef = useRef(null)
  const markersRef = useRef([])

  // Debounced so typing doesn't fire a request on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const hasActiveFilters = !!(filterWilaya || searchInput)
  const resetFilters = () => {
    setFilterWilaya('')
    setSearchInput('')
  }

  const loadList = useCallback(async () => {
    const params = new URLSearchParams()
    if (filterWilaya) params.set('wilaya', filterWilaya)
    if (search) params.set('search', search)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const [needsData, pointsData] = await Promise.all([api(`/needs/${qs}`), api(`/collection-points/${qs}`)])
    setNeeds(needsData.results || needsData)
    setCollectionPoints(pointsData.results || pointsData)
  }, [filterWilaya, search])

  useEffect(() => {
    loadList().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [loadList])

  const zoomToConcernedWilayas = (map) => {
    const centroids = activeCampaignWilayas
      .filter((w) => w.centroid_latitude != null && w.centroid_longitude != null)
      .map((w) => [w.centroid_latitude, w.centroid_longitude])
    if (centroids.length) {
      map.fitBounds(L.latLngBounds(centroids).pad(0.2), { maxZoom: 8 })
    } else {
      map.setView([28.0, 2.6], 5)
    }
  }

  const smartZoom = (map, points, wilayaId) => {
    if (wilayaId) {
      const selected = activeCampaignWilayas.find((w) => String(w.id) === String(wilayaId))
      if (points.length === 0) {
        if (selected && selected.centroid_latitude != null) {
          map.setView([selected.centroid_latitude, selected.centroid_longitude], 10)
        } else {
          zoomToConcernedWilayas(map)
        }
        return
      }
      map.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 12 })
      return
    }
    const doZoom = (userLatLng) => {
      if (userLatLng && isInAlgeria(userLatLng[0], userLatLng[1])) {
        const nearby = points.filter((pt) => haversineKm(userLatLng, pt) <= 50)
        if (nearby.length) {
          map.fitBounds(L.latLngBounds(nearby).pad(0.3), { maxZoom: 11 })
        } else {
          map.setView(userLatLng, 9)
        }
        return
      }
      zoomToConcernedWilayas(map)
    }
    // getCurrentPosition's own `timeout` option isn't honored by every
    // browser -- see NeedsList.jsx's smartZoom for the confirmed case where
    // neither callback ever fired. This manual fallback guarantees the map
    // always gets a view within 3.5s regardless.
    let settled = false
    const settle = (userLatLng) => {
      if (settled) return
      settled = true
      doZoom(userLatLng)
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => settle([pos.coords.latitude, pos.coords.longitude]),
        () => settle(null),
        { timeout: 3000 }
      )
      setTimeout(() => settle(null), 3500)
    } else {
      settle(null)
    }
  }

  useEffect(() => {
    if (viewMode !== 'map') return
    let cancelled = false
    let rafId = null

    ;(async () => {
      const params = new URLSearchParams()
      if (filterWilaya) params.set('wilaya', filterWilaya)
      if (search) params.set('search', search)
      const qs = params.toString() ? `?${params.toString()}` : ''
      let needPins = []
      let cpPins = []
      try {
        ;[needPins, cpPins] = await Promise.all([api(`/needs/locations/${qs}`), api(`/collection-points/locations/${qs}`)])
      } catch {
        return // offline/network failure -- offline banner already informs the user
      }
      if (cancelled) return

      const needsWithPos = needPins.filter((p) => p.display_latitude != null && p.display_longitude != null)
      const cpsWithPos = cpPins.filter((p) => p.display_latitude != null && p.display_longitude != null)
      setMapHasNothing(needsWithPos.length === 0 && cpsWithPos.length === 0)

      rafId = requestAnimationFrame(() => {
        if (cancelled) return
        if (!mapElRef.current) return
        if (!mapRef.current) {
          mapRef.current = L.map(mapElRef.current, {
            attributionControl: false,
            gestureHandling: true,
            gestureHandlingOptions: {
              text: { touch: t('map.gestureTouch'), scroll: t('map.gestureScroll'), scrollMac: t('map.gestureScrollMac') },
            },
          })
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19,
          }).addTo(mapRef.current)
          L.control.attribution({ prefix: false }).addTo(mapRef.current)
        }
        const map = mapRef.current
        markersRef.current.forEach((m) => map.removeLayer(m))
        const markers = []

        needsWithPos.forEach((p) => {
          const marker = L.marker([p.display_latitude, p.display_longitude], { icon: needIcon(L, urgencyColor, p.urgency) }).addTo(map)
          marker.bindPopup(needPopupHtml(t, p, statusLabel))
          markers.push(marker)
        })

        cpsWithPos.forEach((p) => {
          const marker = L.marker([p.display_latitude, p.display_longitude], { icon: collectionPointIcon(L) }).addTo(map)
          marker.bindPopup(collectionPointPopupHtml(t, p))
          markers.push(marker)
        })

        markersRef.current = markers
        const allPoints = [...needsWithPos, ...cpsWithPos].map((p) => [p.display_latitude, p.display_longitude])
        smartZoom(map, allPoints, filterWilaya)
      })
    })()

    return () => {
      cancelled = true
      if (rafId != null) cancelAnimationFrame(rafId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, filterWilaya, search, activeCampaignWilayas])

  const recenterOnMe = async () => {
    const map = mapRef.current
    if (!map) return
    const pos = await getCurrentPosition()
    // See CollectionPoints.jsx's own recenterOnMe -- an explicit tap
    // deserves feedback on failure.
    if (!pos) {
      showAlert(t('map.locationUnavailable'))
      return
    }
    map.fitBounds(L.latLng(pos[0], pos[1]).toBounds(RECENTER_BOX_METERS))
  }

  // Switching to "Liste" unmounts the map div -- see NeedsList.jsx for why
  // the Leaflet instance must be torn down here too.
  useEffect(() => {
    if (viewMode === 'map' || !mapRef.current) return
    mapRef.current.remove()
    mapRef.current = null
    markersRef.current = []
  }, [viewMode])

  const nothingToShow = needs.length === 0 && collectionPoints.length === 0

  return (
    <section className="needs-page">
      <p className="hint">{t('help.instructions')}</p>
      <div className="toolbar">
        <input
          type="search"
          className="search-input"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('common.searchPlaceholder')}
        />
        <label>
          {t('needsList.filterByWilaya')}
          <select value={filterWilaya} onChange={(e) => setFilterWilaya(e.target.value)}>
            <option value="">{t('needsList.all')}</option>
            {activeCampaignWilayas.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        {hasActiveFilters && (
          <button type="button" className="btn" onClick={resetFilters}>
            {t('needsList.resetFilters')}
          </button>
        )}
        <div className="view-toggle">
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
            {t('needsList.list')}
          </button>
          <button className={viewMode === 'map' ? 'active' : ''} onClick={() => setViewMode('map')}>
            {t('needsList.map')}
          </button>
        </div>
      </div>

      {viewMode === 'list' && (
        <>
          {nothingToShow && <p>{t('help.nothingToShow')}</p>}
          {needs.length > 0 && (
            <>
              <h3 className="help-section-heading">🆘 {t('help.needsHeading')}</h3>
              <div className="needs-list">
                {needs.map((n) => (
                  <Link className="need-card" to={`/needs/${n.id}`} key={`need-${n.id}`}>
                    {n.urgency !== 'medium' && <span className={`badge urgency-${n.urgency}`}>{t(`urgency.${n.urgency}`)}</span>}
                    <h3>{n.title}</h3>
                    <p>
                      {n.wilaya_name}
                      {n.commune ? ' — ' + n.commune : ''}
                    </p>
                    <p className="status">{statusLabel(t, n.overall_status)}</p>
                  </Link>
                ))}
              </div>
            </>
          )}
          {collectionPoints.length > 0 && (
            <>
              <h3 className="help-section-heading">📦 {t('help.collectionPointsHeading')}</h3>
              <div className="needs-list">
                {collectionPoints.map((cp) => (
                  <Link className="need-card" to={`/collection-points/${cp.id}`} key={`cp-${cp.id}`}>
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
        </>
      )}

      {viewMode === 'map' && (
        <div className="map-wrap">
          {mapHasNothing && <p className="hint">{t('help.nothingToShow')}</p>}
          <div className="map-frame">
            <div id="help-map" ref={mapElRef} style={{ height: 600 }} />
            <button type="button" className="locate-btn" onClick={recenterOnMe} aria-label={t('map.recenterOnMe')} title={t('map.recenterOnMe')}>
              <IconLocate width={18} height={18} />
            </button>
          </div>
          <div className="legend">
            <span className="legend-item">
              <span className="legend-dot" style={{ background: urgencyColor('critical') }} />
              {t('urgency.critical')}
            </span>
            <span className="legend-item">
              <span className="legend-dot" style={{ background: urgencyColor('medium') }} />
              {t('urgency.medium')}
            </span>
            <span className="legend-note">{t('needsList.legendNote')}</span>
          </div>
        </div>
      )}
    </section>
  )
}
