import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { urgencyColor, haversineKm, isInAlgeria } from '../utils'

function statusLabel(t, s) {
  return t(`status.${s}`, s)
}

// "SOS" speech-bubble mark inside the same white circle/black border pin
// used for collection points and courier markers (see .pickup-marker-pin/
// .cp-marker-pin/.need-marker-pin). Inverted to white -- urgencyColor()
// only ever returns a saturated red/orange/gray, never white, so the icon
// always sits on a colored background here and needs the contrast; the
// source PNG is a solid black mark on transparent, so a CSS filter is all
// that's needed rather than a second asset.
const NEED_SOS_ICON = '<img src="/icons/need-marker-sos.png" width="18" height="18" alt="" style="filter:invert(1)" />'

const CP_BOX_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z"/><path d="M3.5 7.5 12 12l8.5-4.5"/><path d="M12 12v9"/></svg>'

export default function NeedsList() {
  const { t } = useTranslation()
  const { activeCampaignWilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  // '' (both, default) | 'needs' | 'collection_points' -- only affects the
  // map (the list view stays needs-only, unaffected, since that's a
  // different card layout per type).
  const [filterType, setFilterType] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [needs, setNeeds] = useState([])
  // Always defaults to the map on every visit -- deliberately not
  // persisted (a prior "Liste" choice must never keep the map hidden on
  // a later visit; see the toggle buttons below for the session-only
  // manual switch).
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

  const loadNeeds = useCallback(async () => {
    const params = new URLSearchParams()
    if (filterWilaya) params.set('wilaya', filterWilaya)
    if (search) params.set('search', search)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await api(`/needs/${qs}`)
    setNeeds(data.results || data)
  }, [filterWilaya, search])

  useEffect(() => {
    loadNeeds().catch(() => {}) // offline/network failure -- offline banner already informs the user, nothing more to do here
  }, [loadNeeds])

  // Frames the active campaign's authorized wilayas (the affected zones,
  // e.g. the 18 fire wilayas) rather than a flat whole-country view --
  // used whenever there's nothing more specific to zoom to (no pins, no
  // wilaya filter, and the viewer isn't actually in Algeria).
  const zoomToConcernedWilayas = (map) => {
    const centroids = activeCampaignWilayas
      .filter((w) => w.centroid_latitude != null && w.centroid_longitude != null)
      .map((w) => [w.centroid_latitude, w.centroid_longitude])
    if (centroids.length) {
      map.fitBounds(L.latLngBounds(centroids).pad(0.2), { maxZoom: 8 })
    } else {
      map.setView([28.0, 2.6], 5) // last-resort fallback, e.g. before campaigns have loaded yet
    }
  }

  const smartZoom = (map, points, wilayaId) => {
    if (wilayaId) {
      // A wilaya is selected: points already come pre-filtered to it by the
      // API, so just frame them (or fall back to the wilaya's own centroid
      // when it currently has no pins) instead of the geolocation logic below.
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
    // No wilaya filter: show the visitor's actual position if they're
    // genuinely in Algeria, otherwise (diaspora abroad, geolocation
    // denied/unavailable) zoom to the concerned wilayas instead of a
    // generic country-wide view.
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
    let rafId = null

    ;(async () => {
      const params = new URLSearchParams()
      if (filterWilaya) params.set('wilaya', filterWilaya)
      if (search) params.set('search', search)
      const qs = params.toString() ? `?${params.toString()}` : ''
      const wantNeeds = filterType === '' || filterType === 'needs'
      const wantPoints = filterType === '' || filterType === 'collection_points'
      let needPins = []
      let cpPins = []
      try {
        ;[needPins, cpPins] = await Promise.all([
          wantNeeds ? api(`/needs/locations/${qs}`) : Promise.resolve([]),
          wantPoints ? api(`/collection-points/locations/${qs}`) : Promise.resolve([]),
        ])
      } catch {
        return // offline/network failure -- offline banner already informs the user
      }
      if (cancelled) return

      const needsWithPos = needPins.filter((p) => p.display_latitude != null && p.display_longitude != null)
      const cpsWithPos = cpPins.filter((p) => p.display_latitude != null && p.display_longitude != null)
      // The map itself is always shown (see below) -- this only controls
      // whether a supplementary "nothing yet" hint is shown alongside it,
      // e.g. right after a campaign starts before any need has been
      // reported yet.
      setMapHasNothing(needsWithPos.length === 0 && cpsWithPos.length === 0)

      // activeCampaignWilayas can settle in more than one wave while
      // campaigns/wilayas are still loading, re-running this whole effect
      // each time -- checking `cancelled` again here (not just before the
      // network request above) stops a since-superseded run's requestAnimationFrame
      // from firing after its own effect instance was already cleaned up,
      // which otherwise intermittently clobbered a fresher run's markers
      // with a stale (sometimes empty) set on first load.
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
          // Standard OpenStreetMap raster tiles: free with no API key
          // required (unlike CartoDB's basemaps.cartocdn.com, which
          // started requiring one and showed an "API KEY REQUIRED"
          // watermark in production). City/road labels, no elevation
          // relief -- colored pins need to read clearly against the
          // background, which a relief-shaded map fights against.
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
          const icon = L.divIcon({
            className: 'need-marker-icon',
            html: `<span class="need-marker-pin" style="background:${urgencyColor(p.urgency)}">${NEED_SOS_ICON}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          })
          const marker = L.marker([p.display_latitude, p.display_longitude], { icon }).addTo(map)
          const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
          marker.bindPopup(
            `<strong>${p.title}</strong><br>${t(`urgency.${p.urgency}`)} — ${p.wilaya_name}<br>${(p.location_description || '').slice(0, 80)}` +
              `<br>${statusLabel(t, p.overall_status)}${gpsNote}<br><a href="/needs/${p.id}">${t('common.open')}</a>`
          )
          markers.push(marker)
        })

        cpsWithPos.forEach((p) => {
          // Same box-on-a-pin marker used everywhere else for collection
          // points (CollectionPoints.jsx's own map).
          const icon = L.divIcon({
            className: 'cp-marker-icon',
            html: `<span class="cp-marker-pin">${CP_BOX_SVG}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          })
          const marker = L.marker([p.display_latitude, p.display_longitude], { icon }).addTo(map)
          const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
          marker.bindPopup(
            `<strong>${p.point_name}</strong><br>${p.contact_name}${p.organization ? '<br>' + p.organization : ''}` +
              `${p.hours ? '<br>' + p.hours : ''}<br>${p.wilaya_name}${gpsNote}<br><a href="/collection-points/${p.id}">${t('common.open')}</a>`
          )
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
    // activeCampaignWilayas is included so the map re-zooms once campaigns
    // finish loading, in case that response lands after this effect's
    // first run already captured an empty fallback list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, filterWilaya, search, filterType, activeCampaignWilayas])

  // Switching to "Liste" unmounts the #main-map div (see the JSX below),
  // but without this the Leaflet instance in mapRef.current kept pointing
  // at that now-detached DOM node -- switching back to "Carte" then
  // rendered a brand new, empty div that the effect above never
  // re-initialized (its `if (!mapRef.current)` guard saw the stale
  // instance and skipped creating a new one), so the map appeared to
  // vanish permanently after one round-trip through the toggle.
  useEffect(() => {
    if (viewMode === 'map' || !mapRef.current) return
    mapRef.current.remove()
    mapRef.current = null
    markersRef.current = []
  }, [viewMode])

  return (
    <section className="needs-page">
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
        {viewMode === 'map' && (
          <label>
            {t('needsList.filterByType')}
            <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
              <option value="">{t('needsList.typeAll')}</option>
              <option value="needs">{t('needsList.typeNeeds')}</option>
              <option value="collection_points">{t('nav.collectionPoints')}</option>
            </select>
          </label>
        )}
        <div className="view-toggle">
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
            {t('needsList.list')}
          </button>
          <button className={viewMode === 'map' ? 'active' : ''} onClick={() => setViewMode('map')}>
            {t('needsList.map')}
          </button>
        </div>
        <Link className="btn btn-primary" to="/create">
          {t('needsList.addButton')}
        </Link>
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
              {n.location_description && <p className="need-card-description">{n.location_description}</p>}
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
          <div id="main-map" ref={mapElRef} style={{ height: 600 }} />
          {filterType !== 'collection_points' && (
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
          )}
        </div>
      )}
    </section>
  )
}
