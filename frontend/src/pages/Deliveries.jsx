import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { maskPhone, formatDate } from '../utils'
import { IconTruck } from '../icons'

const STATUSES = ['en_route', 'delivered', 'cancelled']

// How often the live-locations map silently refreshes marker positions in
// the background -- frequent enough to feel live, spaced out enough not
// to hammer the server while every visitor's map tab sits open. Never
// re-fits the view on these background ticks (only on the very first
// load), so a viewer's own pan/zoom is never yanked out from under them.
const LIVE_REFRESH_INTERVAL_MS = 20000

export default function Deliveries() {
  const { t, i18n } = useTranslation()
  const { activeCampaignWilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [filterStatus, setFilterStatus] = useState('en_route')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [pickups, setPickups] = useState([])
  // Map first -- seeing where couriers currently are is the more useful
  // default than a text list, same reasoning as NeedsList's own map-first
  // default.
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

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (filterWilaya) params.set('wilaya', filterWilaya)
    if (filterStatus) params.set('status', filterStatus)
    if (search) params.set('search', search)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await api(`/pickups/${qs}`)
    setPickups(data.results || data)
  }, [filterWilaya, filterStatus, search])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  // fitView: true only for the initial load of a map session -- background
  // refresh ticks pass false so they update marker positions in place
  // without moving the map the viewer is currently looking at.
  const renderLiveLocations = useCallback(
    async (fitView) => {
      let locations
      try {
        locations = await api('/pickups/live-locations/')
      } catch {
        return // offline/network failure -- silently skip this refresh, the next tick retries
      }
      if (!mapElRef.current) return
      setMapHasNothing(locations.length === 0)
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
      // Same truck-on-white-circle marker as the per-need live map
      // (NeedDetail.jsx) -- reads as "a delivery" at a glance, distinct
      // from any other pin style in the app.
      const truckIcon = L.divIcon({
        className: 'pickup-marker-icon',
        html:
          '<span class="pickup-marker-pin"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="1.9" ' +
          'stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5h11v8h-11Z"/><path d="M13.5 11h4l3 2.8v1.7h-7Z"/>' +
          '<circle cx="7" cy="18" r="1.7"/><circle cx="17" cy="18" r="1.7"/><path d="M2.5 16h2.8M15.5 16h.2M18.7 16H21"/></svg></span>',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      })
      markersRef.current = locations.map((loc) => {
        // Exactly one of the need_*/collection_point_* pairs is populated,
        // matching whichever this delivery is headed to/from -- see
        // PickupViewSet.live_locations.
        const destHref = loc.need_id ? `/needs/${loc.need_id}` : `/collection-points/${loc.collection_point_id}`
        const destLabel = loc.need_id ? `${loc.need_title} — ${loc.need_wilaya_name}` : `${loc.collection_point_name} — ${loc.collection_point_wilaya_name}`
        const marker = L.marker([loc.latitude, loc.longitude], { icon: truckIcon }).addTo(map)
        marker.bindPopup(
          `<strong>${loc.responder_name}</strong><br>${t('deliveries.bringing')}: ${loc.content_brought || '—'}<br>` +
            `<a href="${destHref}">${destLabel}</a>`
        )
        return marker
      })
      if (fitView) {
        if (locations.length > 1) {
          map.fitBounds(L.latLngBounds(locations.map((l) => [l.latitude, l.longitude])).pad(0.3), { maxZoom: 13 })
        } else if (locations.length === 1) {
          map.setView([locations[0].latitude, locations[0].longitude], 13)
        } else {
          map.setView([28.0, 2.6], 5) // whole-country fallback, nothing to frame yet
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t]
  )

  useEffect(() => {
    if (viewMode !== 'map') return
    renderLiveLocations(true)
    const interval = setInterval(() => renderLiveLocations(false), LIVE_REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [viewMode, renderLiveLocations])

  // Switching to "Liste" unmounts the map div -- tear down the Leaflet
  // instance so switching back to "Carte" builds a fresh one instead of
  // pointing at a stale, now-detached DOM node (see NeedsList.jsx for the
  // same fix, same reason).
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
        <label>
          {t('deliveries.filterByStatus')}
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">{t('deliveries.statusAll')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
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
      </div>

      {viewMode === 'list' && (
        <>
          {pickups.length === 0 && <p>{t('deliveries.noDeliveries')}</p>}
          <div className="needs-list">
            {pickups.map((p) => (
              <Link
                className="need-card"
                to={p.need ? `/needs/${p.need}` : `/collection-points/${p.collection_point}`}
                key={p.id}
              >
                <span className={`badge badge-status-${p.status}`}>{t(`status.${p.status}`)}</span>
                <h3>
                  <IconTruck width={17} height={17} strokeWidth={1.9} className="truck-icon" /> {p.need_title || p.collection_point_name}
                </h3>
                <p>{p.need_wilaya_name || p.collection_point_wilaya_name}</p>
                {!p.is_anonymized && (
                  <p className="status">
                    {t('deliveries.responder')}: {p.organization_or_person_name || p.responder_name} —{' '}
                    {maskPhone(p.responder_phone)}
                  </p>
                )}
                {p.content_brought && (
                  <p className="status">
                    {t('deliveries.bringing')}: {p.content_brought}
                  </p>
                )}
                <p className="status">
                  {t('deliveries.since')} {formatDate(p.pickup_date, i18n.language)}
                </p>
              </Link>
            ))}
          </div>
        </>
      )}

      {viewMode === 'map' && (
        <div className="map-wrap">
          {mapHasNothing && <p className="hint">{t('deliveries.noLiveLocations')}</p>}
          <div id="deliveries-map" ref={mapElRef} style={{ height: 600 }} />
          <p className="legend-note">{t('deliveries.liveMapNote')}</p>
        </div>
      )}
    </section>
  )
}
