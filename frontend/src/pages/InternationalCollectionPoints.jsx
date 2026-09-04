import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { api } from '../api'
import { geocodeCountryBounds } from '../utils'
import CountryOrPlaceSearch from '../components/CountryOrPlaceSearch'

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
  const mapRef = useRef(null)
  const mapElRef = useRef(null)
  const markersRef = useRef([])
  const youAreHereRef = useRef(null)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

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
          fillColor: '#3b82f6',
          fillOpacity: 0.9,
        }).addTo(map)
        marker.bindPopup(t('internationalCollectionPoints.youAreHere')).openPopup()
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

    ;(async () => {
      let pins
      const params = new URLSearchParams({ international: '1' })
      if (filterCountry) params.set('country', filterCountry)
      if (search) params.set('search', search)
      try {
        pins = await api(`/collection-points/locations/?${params.toString()}`)
      } catch {
        return // offline/network failure -- offline banner already informs the user
      }
      if (cancelled) return
      setMapHasNothing(pins.length === 0)

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
        if (youAreHereRef.current) {
          map.removeLayer(youAreHereRef.current)
          youAreHereRef.current = null
        }
        const markers = []

        const withPos = pins.filter((p) => p.display_latitude != null && p.display_longitude != null)
        withPos.forEach((p) => {
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
          marker.bindPopup(
            `<strong>${p.point_name}</strong><br>${p.contact_name}${p.organization ? '<br>' + p.organization : ''}` +
              `${p.hours ? '<br>' + p.hours : ''}<br>${p.country_name || ''}<br><a href="/collection-points/${p.id}">${t('common.open')}</a>`
          )
          markers.push(marker)
        })

        markersRef.current = markers

        if (withPos.length) {
          map.fitBounds(L.latLngBounds(withPos.map((p) => [p.display_latitude, p.display_longitude])).pad(0.3), { maxZoom: 12 })
        } else if (filterCountry) {
          geocodeCountryBounds(filterCountry, i18n.language)
            .then((bounds) => {
              if (cancelled || mapRef.current !== map) return
              if (bounds) {
                // maxZoom only caps how far this can zoom IN -- raised
                // from 6 so a small country (Qatar, Singapore...) isn't
                // left looking oddly distant just because a much bigger
                // country's cap was applied uniformly to all of them.
                map.fitBounds(L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]).pad(0.05), { maxZoom: 8 })
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
  }, [viewMode])

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
          🇩🇿 {t('internationalCollectionPoints.goToNationalLink')}
        </Link>
      </p>
      <div className="toolbar">
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
        {/* Only shown once a filter is actually active -- a discreet text
            link rather than a full button, since resetting isn't a
            primary action on this toolbar. */}
        {hasActiveFilter && (
          <button type="button" className="link" onClick={resetFilters}>
            {t('internationalCollectionPoints.resetFilters')}
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
        {/* Same .toolbar-actions wrapper as CollectionPoints.jsx's own
            action-button pair, for consistent alignment/wrap behavior
            even though this page only ever has the one button. */}
        <div className="toolbar-actions">
          <Link className="btn btn-primary" to="/international-collection-points/create">
            {t('internationalCollectionPoints.addButton')}
          </Link>
        </div>
      </div>

      {viewMode === 'list' && (
        <>
          {points.length === 0 && <p>{t('internationalCollectionPoints.noPointsYet')}</p>}
          <div className="needs-list">
            {points.map((cp) => (
              <Link className="need-card" to={`/collection-points/${cp.id}`} key={cp.id}>
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
          <div id="intl-cp-map" ref={mapElRef} style={{ height: 600 }} />
        </div>
      )}
    </section>
  )
}
