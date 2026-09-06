import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { haversineKm, isInAlgeria, getCurrentPosition, RECENTER_BOX_METERS } from '../utils'
import { fetchDrivingRoute, COLLECTION_POINT_ROUTE_COLOR } from '../routing'
import { countryFlagEmoji, formatApproxKm } from '../mapMarkers'
import { IconLocate, IconExpand, IconClose } from '../icons'

export default function CollectionPoints() {
  const { t } = useTranslation()
  const { activeCampaignWilayas } = useApp()
  const { showAlert } = useDialog()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [points, setPoints] = useState([])
  // Always defaults to the map on every visit -- see NeedsList.jsx for why
  // this is deliberately not persisted.
  const [viewMode, setViewMode] = useState('map')
  const [mapHasNothing, setMapHasNothing] = useState(false)
  // Prototype of a tap-to-activate map, replacing the old two-finger-to-
  // pan gesture handling (confirmed awkward on mobile -- reported live).
  // The map starts "asleep" (dragging/zoom all disabled) so a single
  // finger over it scrolls the *page* exactly like plain text would --
  // no gesture conflict, nothing to explain. A transparent overlay (see
  // JSX below) sits over the whole map while asleep and turns the very
  // first tap anywhere on it (including on a marker) into "wake up"
  // rather than a marker click or a drag; once active, dragging/zoom are
  // enabled like a normal map and a small chip offers an explicit way to
  // put it back to sleep, so scrolling past it with one finger still
  // works afterwards too.
  const [mapActive, setMapActive] = useState(false)
  // Prototype, solution 2: an escape hatch alongside tap-to-activate --
  // reuses this same Leaflet map/markers instance (no second map to keep
  // in sync), just resized into a fixed full-viewport overlay (see the
  // .map-frame-fullscreen CSS + the invalidateSize effect below) for
  // serious exploring (zooming across the whole country, comparing far-
  // apart points) with zero gesture ambiguity, since it owns the entire
  // screen. Always fully interactive on entry -- no tap-to-activate step
  // needed once you've deliberately asked for fullscreen.
  const [fullscreen, setFullscreen] = useState(false)
  // null (nothing yet) | { distanceKm, durationMin } | 'unavailable' (OSRM
  // unreachable) | 'too-far' (beyond the 100km cutoff, see drawRouteToPoint)
  const [routeInfo, setRouteInfo] = useState(null)
  // Visitor's own position, prefetched once on mount purely to show an
  // approximate straight-line distance in each point's own popup (see
  // addPointMarker below) -- a ref (not state) since every popup is bound
  // with a content *function* (Leaflet re-evaluates it fresh on every
  // open, not just once at bind time -- see leaflet-src.js's own
  // _updateContent), so resolving later needs no re-render or effect
  // re-run of its own -- it just shows up next time a popup is opened. A
  // separate, best-effort concern from drawRouteToPoint's own on-click
  // geolocation call (that one draws the actual route + drives the 100km
  // cutoff); this one only ever adds one extra line of text to a popup.
  const myPosRef = useRef(null)
  const mapRef = useRef(null)
  const mapElRef = useRef(null)
  const markersRef = useRef([])
  // Blue "you are here" dot -- only ever placed by an explicit tap of the
  // recenter-on-me button below (unlike InternationalCollectionPoints.jsx,
  // this page's own smartZoom default view never drops one automatically,
  // since it already has a wilaya-based fallback view that doesn't need it).
  const youAreHereRef = useRef(null)
  // The one trajectory line currently drawn (from clicking a point's own
  // marker) -- at most one at a time, same convention as Deliveries.jsx's
  // own courier-to-destination route line.
  const routeLineRef = useRef(null)

  // Debounced so typing doesn't fire a request on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    getCurrentPosition().then((pos) => {
      myPosRef.current = pos
    })
  }, [])

  const hasActiveFilters = !!(filterWilaya || searchInput)
  const resetFilters = () => {
    setFilterWilaya('')
    setSearchInput('')
  }

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (filterWilaya) params.set('wilaya', filterWilaya)
    if (search) params.set('search', search)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await api(`/collection-points/${qs}`)
    setPoints(data.results || data)
  }, [filterWilaya, search])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  // Frames the active campaign's authorized wilayas (the affected zones)
  // rather than a flat whole-country view -- used whenever there's
  // nothing more specific to zoom to.
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

  const smartZoom = (map, mapPoints, wilayaId) => {
    if (wilayaId) {
      const selected = activeCampaignWilayas.find((w) => String(w.id) === String(wilayaId))
      if (mapPoints.length === 0) {
        if (selected && selected.centroid_latitude != null) {
          map.setView([selected.centroid_latitude, selected.centroid_longitude], 10)
        } else {
          zoomToConcernedWilayas(map)
        }
        return
      }
      map.fitBounds(L.latLngBounds(mapPoints).pad(0.3), { maxZoom: 12 })
      return
    }
    // No wilaya filter: show the visitor's actual position if they're
    // genuinely in Algeria, otherwise zoom to the concerned wilayas.
    const doZoom = (userLatLng) => {
      if (userLatLng && isInAlgeria(userLatLng[0], userLatLng[1])) {
        const nearby = mapPoints.filter((pt) => haversineKm(userLatLng, pt) <= 50)
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

  // Draws a trajectory from the visitor's current position to a clicked
  // collection point -- same pattern as Deliveries.jsx's own
  // courier-to-destination route: an immediate straight line (no network
  // dependency), replaced by the real road-following route once/if OSRM
  // resolves. Does nothing (no line, no error) if geolocation is
  // denied/unavailable, same best-effort convention as smartZoom above.
  const drawRouteToPoint = (map, destLat, destLon) => {
    if (routeLineRef.current) {
      map.removeLayer(routeLineRef.current)
      routeLineRef.current = null
    }
    setRouteInfo(null)
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const from = [pos.coords.latitude, pos.coords.longitude]
        const dest = [destLat, destLon]
        // Beyond ~100km, drawing a line across half the country isn't a
        // realistic "drive there" prompt -- skip the route/distance
        // entirely rather than plotting one anyway (the point's own
        // popup with name/contact/hours still shows regardless; this
        // only ever gates the route line and distance readout).
        if (haversineKm(from, dest) > 100) {
          setRouteInfo('too-far')
          return
        }
        const straight = L.polyline([from, dest], { color: COLLECTION_POINT_ROUTE_COLOR, weight: 3, dashArray: '4,8' }).addTo(map)
        routeLineRef.current = straight
        map.fitBounds(L.latLngBounds([from, dest]).pad(0.3), { maxZoom: 13 })
        fetchDrivingRoute(from, dest)
          .then((route) => {
            if (routeLineRef.current !== straight) return // superseded by another click/re-render meanwhile
            map.removeLayer(straight)
            routeLineRef.current = L.polyline(route.coordinates, { color: COLLECTION_POINT_ROUTE_COLOR, weight: 4, dashArray: '1,10', lineCap: 'round' }).addTo(map)
            map.fitBounds(L.latLngBounds(route.coordinates).pad(0.3), { maxZoom: 13 })
            setRouteInfo({ distanceKm: route.distanceKm, durationMin: route.durationMin })
          })
          .catch(() => setRouteInfo('unavailable'))
      },
      () => {},
      { timeout: 8000 }
    )
  }

  useEffect(() => {
    if (viewMode !== 'map') return
    let cancelled = false
    let rafId = null

    ;(async () => {
      let cpPins
      const params = new URLSearchParams()
      if (filterWilaya) params.set('wilaya', filterWilaya)
      if (search) params.set('search', search)
      const qs = params.toString() ? `?${params.toString()}` : ''
      try {
        cpPins = await api(`/collection-points/locations/${qs}`)
      } catch {
        return // offline/network failure -- offline banner already informs the user
      }
      if (cancelled) return
      setMapHasNothing(cpPins.length === 0)

      // activeCampaignWilayas can settle in more than one wave while
      // campaigns/wilayas are still loading, re-running this whole effect
      // each time -- checking `cancelled` again here (not just before the
      // network request above) stops a since-superseded run's
      // requestAnimationFrame from firing after its own effect instance was
      // already cleaned up, which otherwise intermittently clobbered a
      // fresher run's markers with a stale (sometimes empty) set on first
      // load.
      rafId = requestAnimationFrame(() => {
        if (cancelled) return
        if (!mapElRef.current) return
        if (!mapRef.current) {
          mapRef.current = L.map(mapElRef.current, {
            attributionControl: false,
            // Starts fully "asleep" -- see mapActive above -- so a single
            // finger over the map scrolls the page like anything else on
            // it, with no special gesture to learn. activateMap enables
            // all of these once the map is explicitly tapped.
            dragging: false,
            touchZoom: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
          })
          // Standard OpenStreetMap raster tiles -- see NeedsList.jsx for why
          // (CartoDB's free tier now requires an API key).
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19,
          }).addTo(mapRef.current)
          L.control.attribution({ prefix: false }).addTo(mapRef.current)
        }
        const map = mapRef.current
        markersRef.current.forEach((m) => map.removeLayer(m))
        if (youAreHereRef.current) {
          map.removeLayer(youAreHereRef.current)
          youAreHereRef.current = null
        }
        // A marker click draws a fresh trajectory -- clear any leftover one
        // from a previously clicked marker instead of stacking lines up.
        if (routeLineRef.current) {
          map.removeLayer(routeLineRef.current)
          routeLineRef.current = null
        }
        setRouteInfo(null)
        const markers = []

        const cpsWithPos = cpPins.filter((p) => p.display_latitude != null && p.display_longitude != null)

        // See NeedsList.jsx: a box-on-a-pin marker (same package icon
        // used for collection points everywhere else) instead of a
        // plain black square glyph.
        const addPointMarker = (p) => {
          const icon = L.divIcon({
            className: 'cp-marker-icon',
            html:
              '<span class="cp-marker-pin"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2" ' +
              'stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z"/>' +
              '<path d="M3.5 7.5 12 12l8.5-4.5"/><path d="M12 12v9"/></svg></span>',
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          })
          const marker = L.marker([p.display_latitude, p.display_longitude], { icon }).addTo(map)
          // Trajectory from the visitor's own position to this point on
          // click -- same OSRM-backed red line as Deliveries.jsx's own
          // courier-to-destination route. Silently does nothing if
          // geolocation is denied/unavailable, same best-effort convention
          // as every other geolocation use in this app.
          marker.on('click', () => drawRouteToPoint(map, p.display_latitude, p.display_longitude))
          const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
          // A function, not a plain string -- Leaflet re-evaluates it on
          // every popup open (see myPosRef above), so it always reflects
          // whatever position is known *at open time* rather than freezing
          // whatever was known back when this marker was first built.
          marker.bindPopup(() => {
            const distanceNote = myPosRef.current
              ? `<br>${t('map.approxDistance', { km: formatApproxKm(haversineKm(myPosRef.current, [p.display_latitude, p.display_longitude])) })}`
              : ''
            return (
              `<strong>${p.point_name} ${countryFlagEmoji(p.country_code)}</strong><br>${p.contact_name}${p.organization ? '<br>' + p.organization : ''}` +
              `${p.hours ? '<br>' + p.hours : ''}<br>${p.wilaya_name}${gpsNote}${distanceNote}<br><a href="/collection-points/${p.id}">${t('common.open')}</a>`
            )
          })
          markers.push(marker)
        }

        // Points with no precise address all fall back to the same wilaya
        // centroid -- plotting one marker per point would stack them
        // exactly on top of each other. Group those by their (shared)
        // fallback position and show one bubble with a count instead;
        // clicking it filters the list down to that wilaya rather than
        // opening N indistinguishable pins. A point with an exact address
        // (or the only one at its fallback position) still gets its own
        // regular pin, unchanged.
        const exactPins = cpsWithPos.filter((p) => p.has_exact_position)
        const approxGroups = new Map()
        cpsWithPos
          .filter((p) => !p.has_exact_position)
          .forEach((p) => {
            const key = `${p.display_latitude.toFixed(3)},${p.display_longitude.toFixed(3)}`
            if (!approxGroups.has(key)) approxGroups.set(key, [])
            approxGroups.get(key).push(p)
          })

        exactPins.forEach(addPointMarker)
        approxGroups.forEach((group, key) => {
          if (group.length === 1) {
            addPointMarker(group[0])
            return
          }
          const [lat, lon] = key.split(',').map(Number)
          const bubbleIcon = L.divIcon({
            className: 'cp-marker-icon',
            html: `<span class="cp-bubble">${group.length}</span>`,
            iconSize: [34, 34],
            iconAnchor: [17, 17],
          })
          const marker = L.marker([lat, lon], { icon: bubbleIcon, zIndexOffset: 500 }).addTo(map)
          marker.bindTooltip(`${t('common.approxLocationLabel')}<br>${t('common.approxLocationPopup', { count: group.length })}`)
          marker.on('click', () => {
            if (group[0].wilaya != null) setFilterWilaya(String(group[0].wilaya))
            setViewMode('list')
          })
          markers.push(marker)
        })

        markersRef.current = markers
        const allPoints = cpsWithPos.map((p) => [p.display_latitude, p.display_longitude])
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
  }, [viewMode, filterWilaya, search, activeCampaignWilayas])

  const recenterOnMe = async () => {
    const map = mapRef.current
    if (!map) return
    const pos = await getCurrentPosition()
    // Unlike the passive/automatic geolocation attempts elsewhere on this
    // page (smartZoom's own best-effort default view), this button is a
    // deliberate tap -- staying silent on failure just looks broken (most
    // commonly: location access was denied for this site previously, so
    // the browser won't even show the permission prompt again this time).
    if (!pos) {
      showAlert(t('map.locationUnavailable'))
      return
    }
    const [lat, lon] = pos
    // Same blue "you are here" dot as InternationalCollectionPoints.jsx's
    // own recenterOnMe -- was missing here, so a recenter looked like it
    // silently did nothing extra beyond the pan/zoom on this page specifically.
    if (youAreHereRef.current) {
      map.removeLayer(youAreHereRef.current)
      youAreHereRef.current = null
    }
    const marker = L.circleMarker([lat, lon], {
      radius: 8,
      color: '#2563eb',
      weight: 2,
      fillColor: '#3b82f6',
      fillOpacity: 0.9,
    }).addTo(map)
    marker.bindPopup(t('map.youAreHere'))
    youAreHereRef.current = marker
    map.fitBounds(L.latLng(lat, lon).toBounds(RECENTER_BOX_METERS))
  }

  // See NeedsList.jsx for why this is needed: without it, switching back
  // to "Carte" after "Liste" left the map permanently blank.
  useEffect(() => {
    if (viewMode === 'map' || !mapRef.current) return
    mapRef.current.remove()
    mapRef.current = null
    markersRef.current = []
    youAreHereRef.current = null
    routeLineRef.current = null
    setRouteInfo(null)
    setMapActive(false)
    setFullscreen(false)
  }, [viewMode])

  // Wakes the map from its initial "asleep" state (see mapActive above)
  // -- called by the full-cover overlay's own tap, never by anything
  // inside the map itself, so this is the only path that turns dragging
  // on.
  const activateMap = () => {
    const map = mapRef.current
    if (!map) return
    map.dragging.enable()
    map.touchZoom.enable()
    map.scrollWheelZoom.enable()
    map.doubleClickZoom.enable()
    map.boxZoom.enable()
    setMapActive(true)
  }

  const deactivateMap = () => {
    const map = mapRef.current
    if (!map) return
    map.dragging.disable()
    map.touchZoom.disable()
    map.scrollWheelZoom.disable()
    map.doubleClickZoom.disable()
    map.boxZoom.disable()
    setMapActive(false)
  }

  const enterFullscreen = () => {
    activateMap()
    setFullscreen(true)
  }
  const exitFullscreen = () => {
    setFullscreen(false)
    deactivateMap()
  }

  // The container's on-screen size changes (inline height 600 <-> fixed
  // full-viewport) purely via CSS (see .map-frame-fullscreen), which
  // Leaflet has no way to notice on its own -- invalidateSize() forces it
  // to re-measure, or tiles render into the old size/position and the map
  // looks clipped or blank in one of the two modes. The rAF (rather than
  // calling it immediately) waits for the class toggle to actually paint
  // first, since invalidateSize reads the container's live layout.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const rafId = requestAnimationFrame(() => map.invalidateSize())
    return () => cancelAnimationFrame(rafId)
  }, [fullscreen])

  // Fullscreen mode covers the whole viewport -- the page behind it has
  // no business scrolling while it's up (confirmed the alternative is
  // disorienting: the map staying fixed while the page silently scrolls
  // underneath it). Restored unconditionally on unmount too, in case this
  // page is left with fullscreen still open (viewMode switch, navigation).
  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [fullscreen])

  return (
    <section className="needs-page">
      {/* Real, visible descriptive text -- search engines can't read
          meaning from the map/markers alone. */}
      <p className="page-intro">{t('seo.collectionPoints.description')}</p>
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
        {/* Grouped and matched (equal flex share, wraps as a pair) rather
            than two independently-sized buttons trailing the toolbar --
            see .toolbar-actions. */}
        <div className="toolbar-actions">
          <Link className="btn btn-primary" to="/collection-points/create">
            {t('collectionPoints.addButton')}
          </Link>
          {/* Entry point to the separate worldwide page (any country, no
              Algeria restriction) -- see InternationalCollectionPoints.jsx.
              A clearly distinct destination, not a filter on this page,
              since it has its own map default (visitor position, no wilaya
              concept) and never shows couriers/take-charge. */}
          <Link className="btn" to="/international-collection-points">
            {t('internationalCollectionPoints.navButton')}
          </Link>
        </div>
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
          <div className={fullscreen ? 'map-frame map-frame-fullscreen' : 'map-frame'}>
            <div id="cp-map" ref={mapElRef} style={{ height: fullscreen ? '100%' : 600 }} />
            {!mapActive && !fullscreen && (
              <div className="map-activate-overlay" onClick={activateMap} role="button" tabIndex={0} aria-label={t('map.tapToInteract')}>
                <span className="map-activate-hint">{t('map.tapToInteract')}</span>
              </div>
            )}
            {mapActive && !fullscreen && (
              <button type="button" className="map-deactivate-btn" onClick={deactivateMap}>
                {t('map.exitMapInteraction')}
              </button>
            )}
            {!fullscreen && (
              <button
                type="button"
                className="expand-btn"
                onClick={enterFullscreen}
                aria-label={t('map.viewFullscreen')}
                title={t('map.viewFullscreen')}
              >
                <IconExpand width={18} height={18} />
              </button>
            )}
            {fullscreen && (
              <button type="button" className="exit-fullscreen-btn" onClick={exitFullscreen} aria-label={t('map.exitFullscreen')} title={t('map.exitFullscreen')}>
                <IconClose width={20} height={20} />
              </button>
            )}
            <button type="button" className="locate-btn" onClick={recenterOnMe} aria-label={t('map.recenterOnMe')} title={t('map.recenterOnMe')}>
              <IconLocate width={18} height={18} />
            </button>
          </div>
          {routeInfo === 'too-far' && <p className="hint">{t('map.tooFarForRoute')}</p>}
          {routeInfo === 'unavailable' && <p className="hint">{t('map.routeUnavailable')}</p>}
          {routeInfo && routeInfo !== 'unavailable' && routeInfo !== 'too-far' && (
            <p className="status">{t('map.routeDistance', { km: routeInfo.distanceKm.toFixed(1), min: Math.round(routeInfo.durationMin) })}</p>
          )}
        </div>
      )}
    </section>
  )
}
