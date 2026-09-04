import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { maskPhone, formatDate } from '../utils'
import { IconTruck } from '../icons'

const STATUSES = ['en_route', 'delivered', 'cancelled']

// Maps Pickup.responder_type values to the same labels already used at
// take-charge time (TakeCharge.jsx) -- reused here as the closest existing
// concept to "vehicle/type of transporter" rather than inventing a new label set.
const RESPONDER_TYPE_LABEL_KEYS = {
  individual_volunteer: 'takeCharge.individualVolunteer',
  organization: 'takeCharge.organization',
  collective_truck: 'takeCharge.collectiveTruck',
}

// How often the live-locations map silently refreshes marker positions in
// the background -- frequent enough to feel live, spaced out enough not
// to hammer the server while every visitor's map tab sits open. Never
// re-fits the view on these background ticks (only on the very first
// load), so a viewer's own pan/zoom is never yanked out from under them.
const LIVE_REFRESH_INTERVAL_MS = 20000

export default function Deliveries() {
  const { t, i18n } = useTranslation()
  const { activeCampaignWilayas, pickupTokens } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [filterStatus, setFilterStatus] = useState('en_route')
  const [filterDestinationType, setFilterDestinationType] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [pickups, setPickups] = useState([])
  // Map first -- seeing where couriers currently are is the more useful
  // default than a text list, same reasoning as NeedsList's own map-first
  // default.
  const [viewMode, setViewMode] = useState('map')
  // pickup_ids currently shown on the map (live ping or declared departure
  // position) -- used to flag, in the list, which en_route deliveries have
  // neither and so are never on the map at all (never "position
  // unavailable" purely by omission -- see the .noPosition list below).
  const [locatedPickupIds, setLocatedPickupIds] = useState(() => new Set())
  // How many of the currently-filtered en_route deliveries have neither a
  // live ping nor a declared departure position -- shown as one grey
  // "count" bubble on the map (never as individual invented markers, see
  // renderLiveLocations below) so a courier count isn't silently missing
  // from the map with no indication they exist at all.
  const unknownPositionCount = pickups.filter((p) => p.status === 'en_route' && !locatedPickupIds.has(p.id)).length
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
    if (filterDestinationType) params.set('destination_type', filterDestinationType)
    if (search) params.set('search', search)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await api(`/pickups/${qs}`)
    setPickups(data.results || data)
  }, [filterWilaya, filterStatus, filterDestinationType, search])

  const hasActiveFilters = !!(filterWilaya || filterDestinationType || searchInput || filterStatus !== 'en_route')
  const resetFilters = () => {
    setFilterWilaya('')
    setFilterStatus('en_route')
    setFilterDestinationType('')
    setSearchInput('')
  }

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
      // Updated regardless of viewMode -- the list view's "no position"
      // flagging (below) needs this even when the map itself isn't mounted.
      setLocatedPickupIds(new Set(locations.map((l) => l.pickup_id)))
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
      // Same truck-on-white-circle marker as the per-need live map
      // (NeedDetail.jsx) -- reads as "a delivery" at a glance, distinct
      // from any other pin style in the app. The departure-only variant
      // (is_live false -- a declared starting point, not an actual live
      // ping) is visually muted/dashed so it's never mistaken for a
      // currently-tracked courier.
      const truckSvg =
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5h11v8h-11Z"/><path d="M13.5 11h4l3 2.8v1.7h-7Z"/>' +
        '<circle cx="7" cy="18" r="1.7"/><circle cx="17" cy="18" r="1.7"/><path d="M2.5 16h2.8M15.5 16h.2M18.7 16H21"/></svg>'
      const truckIcon = L.divIcon({
        className: 'pickup-marker-icon',
        html: `<span class="pickup-marker-pin">${truckSvg.replace('{color}', '#111')}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      })
      const departureIcon = L.divIcon({
        className: 'pickup-marker-icon pickup-marker-departure',
        html: `<span class="pickup-marker-pin pickup-marker-pin-departure">${truckSvg.replace('{color}', '#888')}</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      })
      markersRef.current = locations.map((loc) => {
        // Exactly one of the need_*/collection_point_* pairs is populated,
        // matching whichever this delivery is headed to/from -- see
        // PickupViewSet.live_locations.
        const destHref = loc.need_id ? `/needs/${loc.need_id}` : `/collection-points/${loc.collection_point_id}`
        const destLabel = loc.need_id ? `${loc.need_title} — ${loc.need_wilaya_name}` : `${loc.collection_point_name} — ${loc.collection_point_wilaya_name}`
        const marker = L.marker([loc.latitude, loc.longitude], { icon: loc.is_live ? truckIcon : departureIcon }).addTo(map)
        const statusLine = loc.is_live
          ? t('deliveries.liveMarkerLabel')
          : t('deliveries.departureMarkerLabel') + (loc.departure_description ? ` (${loc.departure_description})` : '')
        marker.bindPopup(
          `<strong>${loc.responder_name}</strong><br>${t('deliveries.bringing')}: ${loc.content_brought || '—'}<br>` +
            `<em>${statusLine}</em><br><a href="${destHref}">${destLabel}</a>`
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
    // fitView only makes sense once there's an actual map to fit -- in
    // list view this call still runs (to keep locatedPickupIds fresh for
    // the "no position" flagging below), it just no-ops on the map itself
    // since renderLiveLocations bails out early when mapElRef isn't mounted.
    renderLiveLocations(viewMode === 'map')
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
        {/* Transporter info -- name/first name/full name/phone/email all
            searched together server-side (PickupViewSet.get_queryset). */}
        <input
          type="search"
          className="search-input"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('deliveries.searchPlaceholder')}
        />
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
        {/* Destination info -- wilaya here is the destination's wilaya
            (need/collection point), not the courier's current position,
            same as the search box above already matching destination
            name/phone too (see PickupViewSet.get_queryset). */}
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
          {t('deliveries.filterByDestinationType')}
          <select value={filterDestinationType} onChange={(e) => setFilterDestinationType(e.target.value)}>
            <option value="">{t('needsList.all')}</option>
            <option value="need">{t('takeCharge.resourceTypeNeed')}</option>
            <option value="collection_point">{t('needsList.collectionPointLabel')}</option>
          </select>
        </label>
        {hasActiveFilters && (
          <button type="button" className="btn" onClick={resetFilters}>
            {t('deliveries.resetFilters')}
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

      {/* Starting a delivery always begins on the need/collection point's
          own page ("Prendre en charge"/"Prendre en charge une livraison")
          -- these two just get a courier to the right browse screen (map
          or list, same pages as the Besoins/Collecte tabs) to pick which
          one, instead of duplicating that browsing UI here. */}
      <div className="toolbar">
        <Link className="btn btn-primary" to="/needs">
          {t('deliveries.deliverToNeed')}
        </Link>
        <Link className="btn btn-primary" to="/collection-points">
          {t('deliveries.deliverToCollectionPoint')}
        </Link>
      </div>

      {viewMode === 'list' && (
        <>
          {pickups.length === 0 && <p>{t('deliveries.noDeliveries')}</p>}
          <div className="needs-list">
            {pickups.map((p) => {
              const isCollectionPoint = !!p.collection_point
              const destinationName = isCollectionPoint ? p.collection_point_name : p.need_title
              const destinationWilaya = isCollectionPoint ? p.collection_point_wilaya_name : p.need_wilaya_name
              const destinationTypeLabel = isCollectionPoint ? t('needsList.collectionPointLabel') : t('takeCharge.resourceTypeNeed')
              return (
                // Card's own click target is the transporter's own detail
                // page (PickupDetail.jsx via /pickups/:id) -- previously
                // this linked straight to the destination (need/collection
                // point), which made every card read as "a listing of
                // destinations" rather than "a list of transporters" (the
                // destination's own name was the card's bold headline).
                // PickupDetail itself still offers a "view destination"
                // link for whoever wants to go there instead.
                <Link className="need-card" to={`/pickups/${p.id}`} key={p.id}>
                  <span className={`badge badge-status-${p.status}`}>{t(`status.${p.status}`)}</span>
                  {/* pickupTokens only ever holds pickups created in this exact
                      browser (see AppContext) -- lets someone who just took
                      charge of a delivery instantly spot it again in this
                      list instead of hunting for the need/collection point it
                      came from. */}
                  {!!pickupTokens[p.id] && <span className="badge badge-accent">{t('deliveries.yours')}</span>}
                  {/* En route with neither a live ping nor a declared
                      departure position -- explicitly flagged rather than
                      just silently missing from the map, per the "never let
                      a courier look located when they're not" rule. */}
                  {p.status === 'en_route' && !locatedPickupIds.has(p.id) && (
                    <span className="badge badge-muted">{t('deliveries.positionUnavailable')}</span>
                  )}
                  <h3>
                    <IconTruck width={17} height={17} strokeWidth={1.9} className="truck-icon" />{' '}
                    {p.is_anonymized ? t('deliveries.anonymizedResponder') : p.organization_or_person_name || p.responder_name}
                  </h3>
                  {!p.is_anonymized && p.responder_phone && <p className="status">{maskPhone(p.responder_phone)}</p>}
                  {p.responder_type && RESPONDER_TYPE_LABEL_KEYS[p.responder_type] && (
                    <p className="status">
                      {t('deliveries.vehicle')}: {t(RESPONDER_TYPE_LABEL_KEYS[p.responder_type])}
                    </p>
                  )}
                  {destinationName && (
                    <p className="status">
                      {t('deliveries.destination')} ({destinationTypeLabel}): {destinationName}
                      {destinationWilaya ? ` — ${destinationWilaya}` : ''}
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
              )
            })}
          </div>
        </>
      )}

      {viewMode === 'map' && (
        <div className="map-wrap">
          {/* Always shows the map itself -- couriers with a known position
              (live or declared departure) get real markers, everyone else
              en_route is represented by the single unknown-position-chip
              bubble below, never a separate "nothing to show" message
              standing in for the map. */}
          <div className="map-frame">
            <div id="deliveries-map" ref={mapElRef} style={{ height: 600 }} />
            {unknownPositionCount > 0 && (
              <div className="unknown-position-chip">
                <span className="unknown-position-pin">
                  <IconTruck width={16} height={16} strokeWidth={1.9} />
                  <span className="unknown-position-count">{unknownPositionCount}</span>
                </span>
                <span className="unknown-position-label">{t('deliveries.unknownPosition')}</span>
              </div>
            )}
          </div>
          <p className="legend-note">{t('deliveries.liveMapNote')}</p>
        </div>
      )}
    </section>
  )
}
