import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { geocodeCountryBounds, getCurrentPosition, haversineKm, RECENTER_BOX_METERS } from '../utils'
import { fetchDrivingRoute, COLLECTION_POINT_ROUTE_COLOR } from '../routing'
import { countryFlagEmoji, formatApproxKm, flyerPopupButtonHtml, attachPopupPinchZoom, attachMapPinchZoomOverlay } from '../mapMarkers'
import CountryOrPlaceSearch from '../components/CountryOrPlaceSearch'
import PhotoThumb from '../components/PhotoThumb'
import PhotoLightbox from '../components/PhotoLightbox'
import { IconLocate, IconExpand, IconClose, IconAlgeriaFlag } from '../icons'

// Worldwide counterpart to CollectionPoints.jsx -- same map/list page, no
// wilaya (there is none outside Algeria) and no Algeria restriction on
// position. See CreateInternationalCollectionPoint.jsx for the creation
// side, and CollectionPoint.country_code (backend) for how a point is
// marked international in the first place. Deliberately never links to
// take-charge/Pickup anywhere on this page or on the shared detail page
// for one of these points (CollectionPointDetail.jsx guards on
// cp.is_international) -- couriers/drivers only ever operate in Algeria,
// per spec.
export default function InternationalCollectionPoints() {
  const { t, i18n } = useTranslation()
  const { showAlert } = useDialog()
  const [filterCountry, setFilterCountry] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  // True once a place (as opposed to a country) has been picked from the
  // combined search field -- there's no country filter active in that
  // case, but the map has still been moved away from its default view,
  // so the "reset filters" link still needs to show and undo it.
  const [placeActive, setPlaceActive] = useState(false)
  // Bumped on every reset so the field below remounts with a blank
  // query -- it manages its own typed text internally (see
  // CountryOrPlaceSearch), so this is the only way to clear it from here.
  const [locationFieldKey, setLocationFieldKey] = useState(0)
  const [points, setPoints] = useState([])
  const [viewMode, setViewMode] = useState('map')
  const [mapHasNothing, setMapHasNothing] = useState(false)
  const [mapPointsLoading, setMapPointsLoading] = useState(false)
  // Filters tucked behind this toggle instead of always expanded -- same
  // collapsed-by-default pattern as CollectionPoints.jsx/NeedsList.jsx/
  // Deliveries.jsx, so this page's own location/search fields don't always
  // eat vertical space above the map on a short mobile screen.
  const [filtersOpen, setFiltersOpen] = useState(false)
  // Tap-to-activate map -- see CollectionPoints.jsx's own mapActive for
  // the full rationale (replaces the old two-finger-to-pan gesture
  // handling, reported awkward on mobile). Starts "asleep" so a single
  // finger scrolls the page; the first tap wakes it.
  const [mapActive, setMapActive] = useState(false)
  // Fullscreen expand -- see CollectionPoints.jsx's own fullscreen.
  const [fullscreen, setFullscreen] = useState(false)
  // See CollectionPoints.jsx's own lightboxPhoto for the full rationale.
  const [lightboxPhoto, setLightboxPhoto] = useState(null)
  // null (nothing yet) | { distanceKm, durationMin } | 'unavailable' (OSRM
  // unreachable) | 'too-far' (beyond the 100km cutoff, see drawRouteToPoint)
  const [routeInfo, setRouteInfo] = useState(null)
  const mapRef = useRef(null)
  const mapElRef = useRef(null)
  const markersRef = useRef([])
  const youAreHereRef = useRef(null)
  // The one trajectory line currently drawn (from clicking a point's own
  // marker) -- at most one at a time, same convention as Deliveries.jsx's
  // own courier-to-destination route line.
  const routeLineRef = useRef(null)
  // See CollectionPoints.jsx's own hasFramedRef/prevFilterWilayaRef for
  // the full rationale -- a search-only change must never move the map.
  const hasFramedRef = useRef(false)
  const prevFilterCountryRef = useRef(filterCountry)
  // Visitor's own position, prefetched once on mount purely to show an
  // approximate straight-line distance in each point's own popup (see the
  // marker-load effect below) -- see CollectionPoints.jsx's own myPosRef
  // for why this is a ref (popups are bound with a content *function*,
  // re-evaluated fresh on every open, rather than a frozen string) and a
  // separate, best-effort concern from drawRouteToPoint's own on-click
  // geolocation call.
  const myPosRef = useRef(null)

  // Draws a trajectory from the visitor's current position to a clicked
  // collection point -- same pattern as Deliveries.jsx's own
  // courier-to-destination route: an immediate straight line (no network
  // dependency), replaced by the real road-following route once/if OSRM
  // resolves. Does nothing (no line, no error) if geolocation is
  // denied/unavailable, same best-effort convention as defaultZoom below.
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
        // Beyond ~100km, drawing a line across half the world isn't a
        // realistic "drive there" prompt (this page is worldwide, so this
        // matters even more than on CollectionPoints.jsx's own national
        // version) -- skip the route/distance entirely rather than
        // plotting one anyway. The point's own popup with name/contact/
        // hours still shows regardless; this only ever gates the route
        // line and distance readout.
        if (haversineKm(from, dest) > 100) {
          setRouteInfo('too-far')
          return
        }
        const straight = L.polyline([from, dest], { color: COLLECTION_POINT_ROUTE_COLOR, weight: 3, dashArray: '4,8' }).addTo(map)
        routeLineRef.current = straight
        map.fitBounds(L.latLngBounds([from, dest]).pad(0.3), { maxZoom: 13, animate: false })
        fetchDrivingRoute(from, dest)
          .then((route) => {
            if (routeLineRef.current !== straight) return // superseded by another click/re-render meanwhile
            map.removeLayer(straight)
            routeLineRef.current = L.polyline(route.coordinates, { color: COLLECTION_POINT_ROUTE_COLOR, weight: 4, dashArray: '1,10', lineCap: 'round' }).addTo(map)
            map.fitBounds(L.latLngBounds(route.coordinates).pad(0.3), { maxZoom: 13, animate: false })
            setRouteInfo({ distanceKm: route.distanceKm, durationMin: route.durationMin })
          })
          .catch(() => setRouteInfo('unavailable'))
      },
      () => {},
      { timeout: 8000 }
    )
  }

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    getCurrentPosition().then((pos) => {
      myPosRef.current = pos
    })
  }, [])

  const load = useCallback(async () => {
    const params = new URLSearchParams({ international: '1' })
    if (filterCountry) params.set('country', filterCountry)
    if (search) params.set('search', search)
    const data = await api(`/collection-points/?${params.toString()}`)
    setPoints(data.results || data)
  }, [filterCountry, search])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  // A place picked from the combined search field recenters the map --
  // it never touches the association-name search box, but it does clear
  // any active country filter: a place found anywhere in the world would
  // otherwise silently conflict with it, e.g. the map jumping to Tokyo
  // while the list stays filtered to "France".
  const flyTo = ({ lat, lon }, zoom = 12) => {
    setFilterCountry('')
    setPlaceActive(true)
    if (mapRef.current) mapRef.current.setView([lat, lon], zoom)
  }

  const hasActiveFilter = Boolean(filterCountry || searchInput || placeActive)
  const resetFilters = () => {
    setFilterCountry('')
    setSearchInput('')
    setPlaceActive(false)
    setLocationFieldKey((k) => k + 1)
  }

  // No country picked and no place searched yet: default to the visitor's
  // own position, zoomed to roughly a 100km radius (zoom 9, same
  // convention as CollectionPoints.jsx's own "nearby" default) but without
  // the Algeria check (this map is worldwide) -- falls back to a whole-
  // world view if geolocation is denied/unavailable. Marks the spot with
  // a "you are here" marker so the default view reads as intentional
  // rather than the map just looking randomly zoomed in.
  const defaultZoom = (map) => {
    if (!navigator.geolocation) {
      map.setView([20, 10], 2)
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        map.setView([latitude, longitude], 9)
        const marker = L.circleMarker([latitude, longitude], {
          radius: 8,
          color: '#2563eb',
          weight: 2,
          fillColor: '#2563eb',
          fillOpacity: 0.9,
        }).addTo(map)
        marker.bindPopup(t('map.youAreHere')).openPopup()
        youAreHereRef.current = marker
      },
      () => map.setView([20, 10], 2),
      { timeout: 3000 }
    )
  }

  useEffect(() => {
    if (viewMode !== 'map') return
    let cancelled = false
    let rafId = null

    if (!mapRef.current) {
          mapRef.current = L.map(mapElRef.current, {
            attributionControl: false,
            center: [20, 10],
            zoom: 2,
            fadeAnimation: false,
            zoomAnimation: false,
            markerZoomAnimation: false,
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
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; OpenStreetMap contributors',
            maxZoom: 19,
            updateWhenZooming: false,
            keepBuffer: 1,
          }).addTo(mapRef.current)
          L.control.attribution({ prefix: false }).addTo(mapRef.current)
          // See CollectionPoints.jsx's own equivalent registration -- wires
          // up any popup's "view photo" link to the shared PhotoLightbox
          // without closing the popup underneath it.
          mapRef.current.on('popupopen', (e) => {
            const btn = e.popup.getElement()?.querySelector('.popup-photo-btn')
            if (btn) btn.onclick = () => setLightboxPhoto(btn.dataset.photoUrl)
            attachPopupPinchZoom(e.popup.getElement())
          })
          // Also wired from the overlay's own ref callback (for when it
          // remounts later, e.g. deactivate/reactivate) -- done here too
          // since on first mount that ref callback can fire before this
          // effect has actually created the map yet (mapRef.current still
          // null at that point), which would otherwise silently skip
          // wiring it the very first time the page loads.
          attachMapPinchZoomOverlay(mapRef.current, mapElRef.current?.parentElement?.querySelector('.map-activate-overlay'), activateMap)
        }
        

    ;(async () => {
      let pins
      const params = new URLSearchParams({ international: '1' })
      if (filterCountry) params.set('country', filterCountry)
      if (search) params.set('search', search)
      setMapPointsLoading(true)
      try {
        pins = await api(`/collection-points/locations/?${params.toString()}`)
      } catch {
        return // offline/network failure -- offline banner already informs the user
      } finally {
        if (!cancelled) setMapPointsLoading(false)
      }
      if (cancelled) return
      setMapHasNothing(pins.length === 0)

      rafId = requestAnimationFrame(() => {
        if (cancelled) return
        if (!mapElRef.current) return
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

        const withPos = pins.filter((p) => p.display_latitude != null && p.display_longitude != null)

        const addPointMarker = (p) => {
          const icon = L.divIcon({
            className: 'cp-marker-icon',
            html:
              '<span class="cp-marker-pin"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2c8f67" stroke-width="2" ' +
              'stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z"/>' +
              '<path d="M3.5 7.5 12 12l8.5-4.5"/><path d="M12 12v9"/></svg></span>',
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          })
          const marker = L.marker([p.display_latitude, p.display_longitude], { icon }).addTo(map)
          // Trajectory from the visitor's own position to this point on
          // click -- same OSRM-backed red line as Deliveries.jsx's own
          // courier-to-destination route. Silently does nothing if
          // geolocation is denied/unavailable.
          marker.on('click', () => drawRouteToPoint(map, p.display_latitude, p.display_longitude))
          // A function, not a plain string -- Leaflet re-evaluates it on
          // every popup open (see myPosRef above), so it always reflects
          // whatever position is known *at open time* rather than freezing
          // whatever was known back when this marker was first built.
          const photoBtn = flyerPopupButtonHtml(t, p.flyer_image)
          marker.bindPopup(() => {
            const distanceNote = myPosRef.current
              ? `<br>${t('map.approxDistance', { km: formatApproxKm(haversineKm(myPosRef.current, [p.display_latitude, p.display_longitude])) })}`
              : ''
            return (
              `<strong>${p.point_name} ${countryFlagEmoji(p.country_code)}</strong><br>${p.contact_name}${p.organization ? '<br>' + p.organization : ''}` +
              `${p.hours ? '<br>' + p.hours : ''}<br>${p.country_name || ''}${distanceNote}` +
              `<div class="popup-actions">${photoBtn}<a href="/collection-points/${p.id}">${t('common.open')}</a></div>`
            )
          })
          markers.push(marker)
        }

        // Several points geocoded to only a city center (no precise
        // street address) land on the exact same fallback position --
        // group those into one bubble with a count instead of stacking
        // identical pins, same idea as CollectionPoints.jsx's own
        // national map. Clicking the bubble filters the list to that
        // country rather than opening indistinguishable pins one by one.
        const exactPins = withPos.filter((p) => p.has_exact_position)
        const approxGroups = new Map()
        withPos
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
            if (group[0].country_code) {
              setFilterCountry(group[0].country_code)
              setPlaceActive(false)
            }
            setViewMode('list')
          })
          markers.push(marker)
        })

        markersRef.current = markers

        // Reported live: typing a search that matched nothing re-ran the
        // no-country branch below, which jumped the map to the visitor's
        // own geolocated position -- disorienting when they were
        // deliberately looking at a specific area. This whole reframing
        // block now only runs on the map's first appearance or when the
        // country filter itself changes; typing in either search box only
        // ever changes which markers are shown, never the camera. See
        // CollectionPoints.jsx's own hasFramedRef/prevFilterWilayaRef.
        const countryChanged = prevFilterCountryRef.current !== filterCountry
        prevFilterCountryRef.current = filterCountry
        if (hasFramedRef.current && !countryChanged) {
          return
        }
        hasFramedRef.current = true
        if (withPos.length) {
          map.fitBounds(L.latLngBounds(withPos.map((p) => [p.display_latitude, p.display_longitude])).pad(0.3), { maxZoom: 12, animate: false })
        } else if (filterCountry) {
          geocodeCountryBounds(filterCountry, i18n.language)
            .then((bounds) => {
              if (cancelled || mapRef.current !== map) return
              if (bounds) {
                // maxZoom only caps how far this can zoom IN -- raised
                // from 6 so a small country (Qatar, Singapore...) isn't
                // left looking oddly distant just because a much bigger
                // country's cap was applied uniformly to all of them.
                map.fitBounds(L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]).pad(0.05), { maxZoom: 8, animate: false })
              } else {
                defaultZoom(map)
              }
            })
            .catch(() => defaultZoom(map))
        } else {
          defaultZoom(map)
        }
      })
    })()

    return () => {
      cancelled = true
      if (rafId != null) cancelAnimationFrame(rafId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, filterCountry, search])

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
    hasFramedRef.current = false
  }, [viewMode])

  // Wakes the map from its initial "asleep" state (see mapActive above) --
  // see CollectionPoints.jsx's own activateMap for the full rationale.
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

  // See CollectionPoints.jsx's own equivalent effect -- Leaflet has no way
  // to notice the container's on-screen size change (600px <-> fullscreen)
  // on its own.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const rafId = requestAnimationFrame(() => map.invalidateSize())
    return () => cancelAnimationFrame(rafId)
  }, [fullscreen])

  // See CollectionPoints.jsx's own equivalent effect.
  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [fullscreen])

  // Same "you are here" marker as defaultZoom above, but on demand rather
  // than only on first load -- so a manual recenter reads the same way as
  // the automatic one instead of just silently moving the view.
  const recenterOnMe = async () => {
    const map = mapRef.current
    if (!map) return
    const pos = await getCurrentPosition()
    // See CollectionPoints.jsx's own recenterOnMe -- an explicit tap
    // deserves feedback on failure, unlike the passive default-view
    // geolocation attempt elsewhere on this page.
    if (!pos) {
      showAlert(t('map.locationUnavailable'))
      return
    }
    const [lat, lon] = pos
    if (youAreHereRef.current) {
      map.removeLayer(youAreHereRef.current)
      youAreHereRef.current = null
    }
    const marker = L.circleMarker([lat, lon], {
      radius: 8,
      color: '#2563eb',
      weight: 2,
      fillColor: '#2563eb',
      fillOpacity: 0.9,
    }).addTo(map)
    marker.bindPopup(t('map.youAreHere'))
    youAreHereRef.current = marker
    map.fitBounds(L.latLng(lat, lon).toBounds(RECENTER_BOX_METERS))
  }

  return (
    <section className="needs-page">
      <p className="hint">{t('internationalCollectionPoints.intro')}</p>
      {/* Redirect for the common mix-up (someone meaning to browse/create a
          point actually located in Algeria, which belongs on the national
          page instead) -- the flag makes it recognizable at a glance, same
          idea as the equivalent redirect shown when the *create* form's
          position turns out to be inside Algeria. */}
      <p className="hint">
        <Link className="link field-label-icon" to="/collection-points">
          <IconAlgeriaFlag width={16} height={16} /> {t('internationalCollectionPoints.goToNationalLink')}
        </Link>
      </p>
      <div className="toolbar toolbar-compact">
        <button type="button" className="filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
          ☰ {t('common.filters')}
          {hasActiveFilter && <span className="filters-badge" aria-hidden="true" />}
        </button>
        <div className="view-toggle">
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
            {t('needsList.list')}
          </button>
          <button className={viewMode === 'map' ? 'active' : ''} onClick={() => setViewMode('map')}>
            {t('needsList.map')}
          </button>
        </div>
      </div>
      {filtersOpen && (
        <div className="filters-panel">
          <label>
            {t('internationalCollectionPoints.locationLabel')}
            <CountryOrPlaceSearch
              key={locationFieldKey}
              lang={i18n.language}
              placeholder={t('internationalCollectionPoints.locationPlaceholder')}
              onSelectCountry={(code) => {
                setFilterCountry(code)
                setPlaceActive(false)
              }}
              onSelectPlace={flyTo}
              excludeCountryCode="dz"
            />
          </label>
          <input
            type="search"
            className="search-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('internationalCollectionPoints.searchPlaceholder')}
          />
          <button type="button" className="btn" onClick={resetFilters}>
            {t('internationalCollectionPoints.resetFilters')}
          </button>
        </div>
      )}

      {viewMode === 'list' && (
        <>
          {points.length === 0 && <p>{t('internationalCollectionPoints.noPointsYet')}</p>}
          <div className="needs-list">
            {points.map((cp) => (
              <Link className="need-card" to={`/collection-points/${cp.id}`} key={cp.id}>
                <PhotoThumb src={cp.flyer_image} alt={cp.point_name} onOpen={setLightboxPhoto} />
                <h3>{cp.point_name}</h3>
                <p>
                  {cp.country_name}
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
          {mapHasNothing && <p className="hint">{t('internationalCollectionPoints.noPointsYet')}</p>}
          <div className="map-frame">
            <div id="intl-cp-map" ref={mapElRef}  />
            {mapPointsLoading && (
              <div className="map-points-loader" aria-live="polite" aria-label="Chargement des points">
                <span className="map-points-loader-spinner" aria-hidden="true" />
                <span>Chargement des points…</span>
              </div>
            )}
            {!mapActive && !fullscreen && (
              <div
                className="map-activate-overlay"
                onClick={activateMap}
                role="button"
                tabIndex={0}
                aria-label={t('map.tapToInteract')}
                ref={(el) => attachMapPinchZoomOverlay(mapRef.current, el, activateMap)}
              >
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
      <PhotoLightbox src={lightboxPhoto} onClose={() => setLightboxPhoto(null)} />
    </section>
  )
}
