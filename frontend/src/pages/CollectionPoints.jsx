import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { haversineKm, isInAlgeria } from '../utils'
import { countryBubbleIcon } from '../mapMarkers'

export default function CollectionPoints() {
  const { t } = useTranslation()
  const { activeCampaignWilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [points, setPoints] = useState([])
  // Always defaults to the map on every visit -- see NeedsList.jsx for why
  // this is deliberately not persisted.
  const [viewMode, setViewMode] = useState('map')
  const [mapHasNothing, setMapHasNothing] = useState(false)
  const mapRef = useRef(null)
  const mapElRef = useRef(null)
  const markersRef = useRef([])
  // Points whose location is only known at country level get one bubble
  // per country (see CollectionPointViewSet.country_groups) instead of an
  // individual pin -- clicking one opens this list panel rather than a
  // marker popup, since there's no single spot on the map to anchor a
  // popup on. Only shown on the unfiltered view: a wilaya filter implies
  // "Algeria only", where country-only points (all international) never
  // apply anyway.
  const [countryPanel, setCountryPanel] = useState(null) // null | { country, loading, points }

  const openCountryPanel = useCallback(async (country) => {
    setCountryPanel({ country, loading: true, points: [] })
    try {
      const points = await api(`/collection-points/by-country/?country=${encodeURIComponent(country)}`)
      setCountryPanel({ country, loading: false, points })
    } catch {
      setCountryPanel({ country, loading: false, points: [] })
    }
  }, [])

  // Debounced so typing doesn't fire a request on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

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

  useEffect(() => {
    if (viewMode !== 'map') return
    let cancelled = false
    let rafId = null

    ;(async () => {
      let cpPins
      let countryGroups = []
      const params = new URLSearchParams()
      if (filterWilaya) params.set('wilaya', filterWilaya)
      if (search) params.set('search', search)
      const qs = params.toString() ? `?${params.toString()}` : ''
      try {
        cpPins = await api(`/collection-points/locations/${qs}`)
        // Country bubbles are all-international by construction (no wilaya
        // filter can ever match them) -- only fetched on the unfiltered
        // view so picking a wilaya doesn't leave unrelated bubbles on screen.
        if (!filterWilaya) countryGroups = await api('/collection-points/country-groups/')
      } catch {
        return // offline/network failure -- offline banner already informs the user
      }
      if (cancelled) return
      setMapHasNothing(cpPins.length === 0 && countryGroups.length === 0)

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
            gestureHandling: true,
            gestureHandlingOptions: {
              text: { touch: t('map.gestureTouch'), scroll: t('map.gestureScroll'), scrollMac: t('map.gestureScrollMac') },
            },
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
        const markers = []

        const cpsWithPos = cpPins.filter((p) => p.display_latitude != null && p.display_longitude != null)
        cpsWithPos.forEach((p) => {
          // See NeedsList.jsx: a box-on-a-pin marker (same package icon
          // used for collection points everywhere else) instead of a
          // plain black square glyph.
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
          const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
          const place = p.wilaya_name || p.city || p.country || ''
          marker.bindPopup(
            `<strong>${p.point_name}</strong><br>${p.contact_name}${p.organization ? '<br>' + p.organization : ''}` +
              `${p.hours ? '<br>' + p.hours : ''}<br>${place}${gpsNote}<br><a href="/collection-points/${p.id}">${t('common.open')}</a>`
          )
          markers.push(marker)
        })

        countryGroups
          .filter((g) => g.latitude != null && g.longitude != null)
          .forEach((g) => {
            const marker = L.marker([g.latitude, g.longitude], { icon: countryBubbleIcon(L, g.count) }).addTo(map)
            // Deliberately no popup here -- per spec, clicking a
            // country-only bubble lists its points (openCountryPanel)
            // instead of opening a single-point-style popup, since none of
            // them has a location precise enough to anchor one on.
            marker.on('click', () => openCountryPanel(g.country))
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

  // See NeedsList.jsx for why this is needed: without it, switching back
  // to "Carte" after "Liste" left the map permanently blank.
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
        <Link className="btn" to="/collection-points/submit-flyer">
          {t('collectionPoints.addViaFlyer')}
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
                  {cp.wilaya_name || cp.city || cp.country}
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
          <div id="cp-map" ref={mapElRef} style={{ height: 600 }} />
          {countryPanel && (
            <div className="country-points-panel">
              <div className="toolbar">
                <h3>{t('collectionPoints.countryBubbleTitle', { country: countryPanel.country })}</h3>
                <button type="button" className="link" onClick={() => setCountryPanel(null)}>
                  {t('common.close')}
                </button>
              </div>
              {countryPanel.loading && <p>{t('common.loading')}</p>}
              {!countryPanel.loading && countryPanel.points.length === 0 && <p>{t('collectionPoints.noPointsYet')}</p>}
              <div className="needs-list">
                {countryPanel.points.map((cp) => (
                  <Link className="need-card" to={`/collection-points/${cp.id}`} key={cp.id}>
                    <h3>{cp.point_name}</h3>
                    <p>
                      {cp.city}
                      {cp.organization ? ' — ' + cp.organization : ''}
                    </p>
                    <p className="status">{cp.status === 'closed' ? t('status.closed') : cp.hours || t('collectionPoints.hoursNotSpecified')}</p>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
