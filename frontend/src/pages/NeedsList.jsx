import { useState, useEffect, useRef, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { urgencyColor, haversineKm, isInAlgeria, getCurrentPosition, RECENTER_BOX_METERS } from '../utils'
import { flyerPopupButtonHtml, attachMapPopupBehavior, attachMapTapToActivate } from '../mapMarkers'
import PhotoThumb from '../components/PhotoThumb'
import PhotoLightbox from '../components/PhotoLightbox'
import { IconLocate, IconExpand, IconClose } from '../icons'

function statusLabel(t, s) {
  return t(`status.${s}`, s)
}

// Popup content below is built as raw HTML strings (Leaflet's bindPopup
// takes a string, not JSX) -- title/location_description are free text the
// reporter typed, so they're escaped before interpolation. wilaya_name and
// every other field used come from the backend's own fixed data (never
// reporter-controlled), same as elsewhere in this file/mapMarkers.js.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// "SOS" speech-bubble mark inside the same white circle/black border pin
// used for collection points and courier markers (see .pickup-marker-pin/
// .cp-marker-pin/.need-marker-pin). Inverted to white -- urgencyColor()
// only ever returns a saturated red/orange/gray, never white, so the icon
// always sits on a colored background here and needs the contrast; the
// source PNG is a solid black mark on transparent, so a CSS filter is all
// that's needed rather than a second asset.
const NEED_SOS_ICON = '<img src="/icons/need-marker-sos.png" width="18" height="18" alt="" style="filter:invert(1)" />'

export default function NeedsList() {
  const { t } = useTranslation()
  const { activeCampaignWilayas } = useApp()
  const { showAlert } = useDialog()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [needs, setNeeds] = useState([])
  // Always defaults to the map on every visit -- deliberately not
  // persisted (a prior "Liste" choice must never keep the map hidden on
  // a later visit; see the toggle buttons below for the session-only
  // manual switch).
  const [viewMode, setViewMode] = useState('map')
  const [mapHasNothing, setMapHasNothing] = useState(false)
  const [mapPointsLoading, setMapPointsLoading] = useState(false)
  // Filters (search + wilaya) tucked behind this toggle instead of always
  // expanded -- see CollectionPoints.jsx's own filtersOpen for the
  // rationale (same pattern, reused across every map+filters page).
  const [filtersOpen, setFiltersOpen] = useState(false)
  // See CollectionPoints.jsx's own lightboxPhoto for the full rationale.
  const [lightboxPhoto, setLightboxPhoto] = useState(null)
  // Tap-to-activate map -- see CollectionPoints.jsx's own mapActive for
  // the full rationale (replaces the old two-finger-to-pan gesture
  // handling, reported awkward on mobile). Starts "asleep" so a single
  // finger scrolls the page; the first tap wakes it.
  const [mapActive, setMapActive] = useState(false)
  // Fullscreen expand -- see CollectionPoints.jsx's own fullscreen.
  const [fullscreen, setFullscreen] = useState(false)
  // Map fills the remaining viewport height -- see CollectionPoints.jsx's
  // own mapFillHeight for the full rationale.
  const [mapFillHeight, setMapFillHeight] = useState(500)
  const mapFrameRef = useRef(null)
  const mapRef = useRef(null)
  const mapElRef = useRef(null)
  const markersRef = useRef([])
  // See CollectionPoints.jsx's own hasFramedRef/prevFilterWilayaRef for
  // the full rationale -- a search-only change must never move the map.
  const hasFramedRef = useRef(false)
  const prevFilterWilayaRef = useRef(filterWilaya)
  // Which need's voice recording (if any) is currently playing in the
  // "Liste" view below -- at most one at a time, so starting a second clip
  // stops the first instead of both playing over each other.
  const [playingNeedId, setPlayingNeedId] = useState(null)
  const playingAudioRef = useRef(null)

  // Debounced so typing doesn't fire a request on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Stops on unmount (e.g. navigating away from this page mid-playback) --
  // switching away from the "Liste" view itself doesn't need its own
  // handling since that view's cards (and this state) simply stop being
  // rendered/relevant, same as any other React state on an unmounted branch.
  useEffect(() => () => playingAudioRef.current?.pause(), [])

  const toggleAudio = (needId, url) => {
    playingAudioRef.current?.pause()
    if (playingNeedId === needId) {
      setPlayingNeedId(null) // same button tapped again -- just stop
      return
    }
    const audio = new Audio(url)
    audio.addEventListener('ended', () => setPlayingNeedId(null))
    audio.play().catch(() => {})
    playingAudioRef.current = audio
    setPlayingNeedId(needId)
  }

  const hasActiveFilters = !!(filterWilaya || searchInput)
  const resetFilters = () => {
    setFilterWilaya('')
    setSearchInput('')
  }

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
      map.fitBounds(L.latLngBounds(centroids).pad(0.2), { maxZoom: 8, animate: false })
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
      map.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 12, animate: false })
      return
    }
    // No wilaya filter: this page is Algeria-only. Do not wait for the
    // browser geolocation before framing the campaign points. A visitor
    // in France must immediately see the Algeria view; the explicit
    // "Me localiser" control remains responsible for GPS positioning.
    if (points.length) {
      map.fitBounds(L.latLngBounds(points).pad(0.3), { maxZoom: 11, animate: false })
    } else {
      zoomToConcernedWilayas(map)
    }
  }

  useEffect(() => {
    if (viewMode !== 'map') return
    let cancelled = false
    let rafId = null

    if (!mapRef.current) {
          mapRef.current = L.map(mapElRef.current, {
            attributionControl: false,
            center: [28, 2.6],
            zoom: 5,
            fadeAnimation: false,
            zoomAnimation: false,
            markerZoomAnimation: false,
            // Starts fully "asleep" -- see mapActive above -- so a single
            // finger over the map scrolls the page like anything else on
            // it. activateMap enables all of these once explicitly tapped.
            dragging: false,
            touchZoom: false,
            scrollWheelZoom: false,
            doubleClickZoom: false,
            boxZoom: false,
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
            updateWhenZooming: false,
            keepBuffer: 1,
          }).addTo(mapRef.current)
          L.control.attribution({ prefix: false }).addTo(mapRef.current)
          // See CollectionPoints.jsx's own equivalent registration -- wires
          // up any popup's "view photo" link to the shared PhotoLightbox
          // without closing the popup underneath it.
          attachMapPopupBehavior(mapRef.current, (photoUrl) => setLightboxPhoto(photoUrl))
          // Also wired from the overlay's own ref callback (for when it
          // remounts later, e.g. deactivate/reactivate) -- done here too
          // since on first mount that ref callback can fire before this
          // effect has actually created the map yet (mapRef.current still
          // null at that point), which would otherwise silently skip
          // wiring it the very first time the page loads.
          attachMapTapToActivate(mapRef.current, activateMap)
        }
        

    ;(async () => {
      const params = new URLSearchParams()
      if (filterWilaya) params.set('wilaya', filterWilaya)
      if (search) params.set('search', search)
      const qs = params.toString() ? `?${params.toString()}` : ''
      let needPins = []
      setMapPointsLoading(true)
      try {
        // This is the SOS/Besoins map specifically -- needs only, never
        // collection points (those get their own map on CollectionPoints.jsx,
        // and both together on the combined "Je veux aider" map/HelpMap.jsx).
        needPins = await api(`/needs/locations/${qs}`)
      } catch {
        return // offline/network failure -- offline banner already informs the user
      } finally {
        if (!cancelled) setMapPointsLoading(false)
      }
      if (cancelled) return

      const needsWithPos = needPins.filter((p) => p.display_latitude != null && p.display_longitude != null)
      // The map itself is always shown (see below) -- this only controls
      // whether a supplementary "nothing yet" hint is shown alongside it,
      // e.g. right after a campaign starts before any need has been
      // reported yet.
      setMapHasNothing(needsWithPos.length === 0)

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
        const map = mapRef.current
        markersRef.current.forEach((m) => map.removeLayer(m))
        const markers = []

        // Needs reported with no location fix at all (guided voice flow,
        // geolocation declined/failed -- see has_no_location, backend) all
        // share the same fallback position (the campaign's fallback
        // wilaya's own centroid), so plotting one pin per need would stack
        // them exactly on top of each other. Grouped into one big red
        // bubble with a count instead -- same "one badge, not N
        // indistinguishable pins" idea as CollectionPoints.jsx's own
        // .cp-bubble, and (per explicit request) the same click behavior
        // too: switch to the "Liste" view filtered to that wilaya, rather
        // than an in-place popup.
        const located = needsWithPos.filter((p) => !p.has_no_location)
        const unlocated = needsWithPos.filter((p) => p.has_no_location)

        located.forEach((p) => {
          const icon = L.divIcon({
            className: 'need-marker-icon',
            html: `<span class="need-marker-pin" style="background:${urgencyColor(p.urgency)}">${NEED_SOS_ICON}</span>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          })
          const marker = L.marker([p.display_latitude, p.display_longitude], { icon }).addTo(map)
          const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
          const urgencyPrefix = p.urgency !== 'medium' ? `${t(`urgency.${p.urgency}`)} — ` : ''
          const photoBtn = flyerPopupButtonHtml(t, p.photo)
          marker.bindPopup(
            `<strong>${escapeHtml(p.title)}</strong><br>${urgencyPrefix}${p.wilaya_name}<br>${escapeHtml((p.location_description || '').slice(0, 80))}` +
              `<br>${statusLabel(t, p.overall_status)}${gpsNote}` +
              `<div class="popup-actions">${photoBtn}<a href="/needs/${p.id}">${t('common.open')}</a></div>`
          )
          markers.push(marker)
        })

        if (unlocated.length) {
          const icon = L.divIcon({
            className: 'need-marker-icon',
            html:
              `<span class="need-marker-pin need-marker-pin-unlocated">${NEED_SOS_ICON}` +
              `<span class="need-marker-count-badge">${unlocated.length}</span></span>`,
            iconSize: [44, 44],
            iconAnchor: [22, 22],
          })
          const marker = L.marker([unlocated[0].display_latitude, unlocated[0].display_longitude], { icon, zIndexOffset: 1000 }).addTo(map)
          marker.bindTooltip(`${t('needsList.noLocationBubbleLabel')} (${unlocated.length})`)
          marker.on('click', () => {
            if (unlocated[0].wilaya != null) setFilterWilaya(String(unlocated[0].wilaya))
            setViewMode('list')
          })
          markers.push(marker)
        }

        markersRef.current = markers
        const allPoints = needsWithPos.map((p) => [p.display_latitude, p.display_longitude])
        const wilayaChanged = prevFilterWilayaRef.current !== filterWilaya
        prevFilterWilayaRef.current = filterWilaya
        if (!hasFramedRef.current || wilayaChanged) {
          hasFramedRef.current = true
          smartZoom(map, allPoints, filterWilaya)
        }
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
    const pos = await getCurrentPosition({
      maximumAge: 30000,
      timeout: 3000,
      enableHighAccuracy: false,
    })
    // See CollectionPoints.jsx's own recenterOnMe -- an explicit tap
    // deserves feedback on failure.
    if (!pos) {
      showAlert(t('map.locationUnavailable'))
      return
    }
    map.fitBounds(L.latLng(pos[0], pos[1]).toBounds(RECENTER_BOX_METERS))
  }

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
    setMapActive(false)
    setFullscreen(false)
    hasFramedRef.current = false
  }, [viewMode])

  // See CollectionPoints.jsx's own activateMap/deactivateMap/
  // enterFullscreen/exitFullscreen for the full rationale.
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

    // Use the native Fullscreen API when the browser supports it. The CSS
    // fullscreen class remains the fallback for browsers that reject or do
    // not expose requestFullscreen (notably some iOS contexts).
    const frame = mapFrameRef.current
    if (frame?.requestFullscreen) {
      frame.requestFullscreen({ navigationUI: 'hide' }).catch(() => {
        // CSS fallback is already active through setFullscreen(true).
      })
    }
  }
  const exitFullscreen = () => {
    const frame = mapFrameRef.current
    if (document.fullscreenElement === frame) {
      const exitPromise = document.exitFullscreen?.()
      exitPromise?.catch(() => {})
    }
    setFullscreen(false)
    deactivateMap()
  }

  // Keep React state synchronized with browser fullscreen (including the
  // Android back/escape gesture) and refresh Leaflet after the frame changes
  // size. Leaflet documents invalidateSize() as the required call after a
  // map container is resized dynamically.
  useEffect(() => {
    const onFullscreenChange = () => {
      const nativeFullscreen = document.fullscreenElement === mapFrameRef.current
      setFullscreen(nativeFullscreen)
      if (!nativeFullscreen) deactivateMap()

      requestAnimationFrame(() => {
        mapRef.current?.invalidateSize({ pan: false, animate: false })
        requestAnimationFrame(() => mapRef.current?.invalidateSize({ pan: false, animate: false }))
      })
    }

    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const rafId = requestAnimationFrame(() => map.invalidateSize())
    return () => cancelAnimationFrame(rafId)
  }, [fullscreen, mapFillHeight])

  useEffect(() => {
    if (!fullscreen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [fullscreen])

  // Airbnb-style "map fills the screen" -- see CollectionPoints.jsx's own
  // equivalent effect for the full rationale.
  useEffect(() => {
    if (viewMode !== 'map' || fullscreen) return
    const el = mapFrameRef.current
    if (!el) return
    const BOTTOM_NAV_CLEARANCE = 90
    const MIN_HEIGHT = 160
    const recompute = () => {
      const top = el.getBoundingClientRect().top
      setMapFillHeight(Math.max(MIN_HEIGHT, Math.round(window.innerHeight - top - BOTTOM_NAV_CLEARANCE)))
    }
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [viewMode, fullscreen, filtersOpen, mapHasNothing])

  return (
    <section className="needs-page needs-page-map-fill">
      {/* Reporting a need is now reachable from the header nav ("J'ai
          besoin d'aide") and the Home page's own SOS button, so this
          toolbar no longer needs its own create button -- see
          CollectionPoints.jsx's equivalent cleanup. */}
      <div className="toolbar toolbar-compact">
        <button type="button" className="filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
          ☰ {t('common.filters')}
          {hasActiveFilters && <span className="filters-badge" aria-hidden="true" />}
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
          <input
            type="search"
            className="search-input"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('needsList.searchPlaceholder')}
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
          <button type="button" className="btn" onClick={resetFilters}>
            {t('needsList.resetFilters')}
          </button>
        </div>
      )}

      {viewMode === 'list' && (
        <div className="needs-list">
          {needs.length === 0 && <p>{t('needsList.noActiveNeeds')}</p>}
          {needs.map((n) => (
            <Link className="need-card" to={`/needs/${n.id}`} key={n.id}>
              <PhotoThumb src={n.damage_photos?.find((p) => p.image)?.image} alt={n.title} onOpen={setLightboxPhoto} />
              {n.urgency !== 'medium' && (
                <span className={`badge urgency-${n.urgency}`}>{t(`urgency.${n.urgency}`)}</span>
              )}
              <h3>{n.title}</h3>
              {/* has_no_location means the wilaya below is only a
                  submission-time fallback (see NeedCreateSerializer,
                  backend), never a place the reporter actually confirmed
                  -- showing it plainly here would read as a real location
                  when it isn't one. */}
              {n.has_no_location ? (
                <p className="hint">{t('needsList.noGeographicPosition')}</p>
              ) : (
                <p>
                  {n.wilaya_name}
                  {n.commune ? ' — ' + n.commune : ''}
                </p>
              )}
              {n.location_description && <p className="need-card-description">{n.location_description}</p>}
              <p className="status">
                {statusLabel(t, n.overall_status)} — {t('needsList.pickupsCount', { count: n.pickups.length })}
              </p>
              {/* A voice-reported SOS (see the guided voice flow) carries
                  its actual content as an audio recording rather than
                  text -- offered right here (not just on the detail page)
                  since this is exactly the list a "sans localisation"
                  bubble tap lands on (see the map effect above). Stops
                  the card's own <Link> navigation, same reasoning as
                  PhotoThumb's own onOpen button elsewhere in this list. */}
              {n.voice_file && (
                <button
                  type="button"
                  className="need-card-audio-btn"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    toggleAudio(n.id, n.voice_file)
                  }}
                >
                  {playingNeedId === n.id ? `⏸ ${t('needsList.stopAudio')}` : `🔊 ${t('needsList.playAudio')}`}
                </button>
              )}
            </Link>
          ))}
        </div>
      )}

      {viewMode === 'map' && (
        <div className="map-wrap">
          {mapHasNothing && <p className="hint">{t('needsList.noActiveNeeds')}</p>}
          <div
            className={`map-frame${fullscreen ? ' map-frame-fullscreen' : ''}`}
            ref={mapFrameRef}
          >
            <div id="main-map" ref={mapElRef} style={{ height: '100%' }} />
            {mapPointsLoading && (
              <div className="map-points-loader" aria-live="polite" aria-label="Chargement des points">
                <span className="map-points-loader-spinner" aria-hidden="true" />
                <span>Chargement des points…</span>
              </div>
            )}
            {!mapActive && !fullscreen && (
              <div
                className="map-activate-overlay map-activate-hint-only"
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
      <PhotoLightbox src={lightboxPhoto} onClose={() => setLightboxPhoto(null)} />
    </section>
  )
}
