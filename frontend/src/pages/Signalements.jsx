import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { translateApiError } from '../apiErrors'
import { getCurrentPosition, haversineKm, RECENTER_BOX_METERS } from '../utils'
import { attachMapTapToActivate } from '../mapMarkers'
import { IconClose, IconExpand, IconLocate, IconPlus } from '../icons'
import WilayaCombobox from '../components/WilayaCombobox'
import { SIGNALI_CATEGORIES, SIGNAL_ICON_SVG, categoryEmoji, categoryIconHtml, getOwnSignalementIds } from '../signali'
import CategoryIcon from '../components/CategoryIcon'
import '../signali.css'

// The Signali map: every public citizen report (see
// core.signalements.public_signalements), filterable by wilaya, category
// and status. Open reports blink; reports with no exact position (an
// address typed without a map pin, an admin testing from abroad) are
// grouped into one big "no location" bubble instead of piling up on
// their wilaya's centroid. Tapping a pin shows a preview that opens the
// report's own page (SignalementDetail.jsx). ?focus=<id> centers on one
// report -- also fetched on its own, since a report still being checked
// isn't in the public list yet. Same map chrome as the other maps
// (NeedsList.jsx): hidden filters panel, "tap to interact" overlay,
// fullscreen, "center on me", and a map that fills the screen. A report
// is public as soon as it's sent; only its photos/video wait for their
// check.

function pinIcon(s, selected) {
  const open = s.status === 'new' || s.status === 'in_review'
  const cls = [
    'signali-marker',
    open ? 'is-open' : 'is-resolved',
    selected ? 'is-selected' : '',
  ].join(' ')
  return L.divIcon({ className: 'signali-marker-icon', html: `<span class="${cls}">${categoryIconHtml(s.category)}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] })
}


// Pins and bubbles that land (almost) on the same spot are nudged apart
// on screen so each stays visible and tappable -- same idea as
// mapMarkers.spreadNeedMarkers, with a wider spread since several
// reports often share one wilaya centre. Re-run on every zoom.
const SPREAD_MIN_PX = 58
const SPREAD_MAX_PX = 90
function spreadSignaliMarkers(map) {
  const markers = []
  map.eachLayer((layer) => layer instanceof L.Marker && layer._icon && markers.push(layer))
  const pos = markers.map((m) => map.latLngToContainerPoint(m.getLatLng()))
  const off = markers.map(() => ({ x: 0, y: 0 }))
  for (let pass = 0; pass < 8; pass += 1) {
    for (let i = 0; i < pos.length; i += 1) {
      for (let j = i + 1; j < pos.length; j += 1) {
        const dx = pos[j].x + off[j].x - (pos[i].x + off[i].x)
        const dy = pos[j].y + off[j].y - (pos[i].y + off[i].y)
        const d = Math.hypot(dx, dy)
        if (d >= SPREAD_MIN_PX) continue
        const push = (SPREAD_MIN_PX - (d || 1)) / 2 + 1
        const ux = d ? dx / d : Math.cos(i * 97 + j * 53)
        const uy = d ? dy / d : Math.sin(i * 97 + j * 53)
        off[i].x -= ux * push
        off[i].y -= uy * push
        off[j].x += ux * push
        off[j].y += uy * push
      }
    }
  }
  markers.forEach((m, i) => {
    const el = m._icon.firstElementChild
    if (!el) return
    const clamp = (v) => Math.max(-SPREAD_MAX_PX, Math.min(SPREAD_MAX_PX, v))
    m._signaliOffset = [clamp(off[i].x), clamp(off[i].y)]
    el.style.translate = `${m._signaliOffset[0]}px ${m._signaliOffset[1]}px`
  })
  if (!map._signaliSpreadWired) {
    map._signaliSpreadWired = true
    map.on('zoomend', () => spreadSignaliMarkers(map))
  }
}

function bubbleIcon(count) {
  return L.divIcon({
    className: 'signali-marker-icon',
    html: `<span class="signali-bubble">${SIGNAL_ICON_SVG}<b>${count}</b></span>`,
    iconSize: [64, 64],
    iconAnchor: [32, 32],
  })
}

// A report's thumbnail: its first photo, else a frame of its video (with
// a ▶ badge), else its category's icon -- always with the category icon
// as a small corner badge so the type reads at a glance.
function Thumb({ s, size }) {
  const photo = s.photos.find((p) => p.image)?.image
  const cls = `signali-thumb-box signali-thumb-${size}`
  return (
    <span className={cls}>
      {photo ? (
        <img src={photo} alt="" loading="lazy" />
      ) : s.video_file ? (
        <>
          <video src={`${s.video_file}#t=0.5`} muted playsInline preload="metadata" />
          <span className="signali-thumb-play" aria-hidden="true">▶</span>
        </>
      ) : (
        <CategoryIcon category={s.category} className="signali-thumb-icon" />
      )}
      {(photo || s.video_file) && <CategoryIcon category={s.category} className="signali-thumb-badge" />}
    </span>
  )
}

const escapeHtml = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Popup on a pin, like the other maps: the photo (or the video's first
// frame), the type, a very short description, and a link to the full
// report (photos, video, voice, comments...).
function popupHtml(t, s) {
  const photo = s.photos.find((p) => p.image)?.image
  const media = photo
    ? `<img class="signali-popup-media" src="${escapeHtml(photo)}" alt="" />`
    : s.video_file
      ? `<video class="signali-popup-media" src="${escapeHtml(s.video_file)}#t=0.5" muted playsinline preload="metadata"></video>`
      : ''
  const text = (s.description || s.voice_transcript || '').trim()
  const short = text.length > 70 ? `${text.slice(0, 70)}…` : text
  return (
    `<div class="signali-popup">${media}` +
    `<strong>${categoryIconHtml(s.category)} ${escapeHtml(t(`signali.categories.${s.category}`))}</strong>` +
    `<small>${escapeHtml([s.address || s.commune, s.wilaya_name].filter(Boolean).join(' · '))}</small>` +
    (short ? `<p>${escapeHtml(short)}</p>` : '') +
    `<a href="/signalements/${s.id}" data-signali-id="${s.id}">${escapeHtml(t('signali.openReport'))} →</a></div>`
  )
}

export default function Signalements() {
  const { t } = useTranslation()
  const { wilayas, config } = useApp()
  const { showAlert } = useDialog()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [filtersOpen, setFiltersOpen] = useState(false)
  // Same "Liste / Carte" toggle as NeedsList.jsx. The map stays mounted
  // (just hidden) in list mode, so switching back keeps its position.
  const [viewMode, setViewMode] = useState('map')
  const [ownPending, setOwnPending] = useState([])
  const [items, setItems] = useState([])
  const [focusedReport, setFocused] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [noLocationOnly, setNoLocationOnly] = useState(false)

  const wilaya = params.get('wilaya') || ''
  const category = params.get('category') || ''
  const status = params.get('status') || 'open'
  const focusId = Number(params.get('focus')) || null
  // "Géolocalisés / Sans géolocalisation / Tous".
  const geo = params.get('geo') || 'all'
  // ?near=1 (Home's "around me" button): only reports within NEAR_KM of
  // the visitor's position.
  const nearMode = params.get('near') === '1'
  const NEAR_KM = 30
  const [nearPos, setNearPos] = useState(null)
  const [nearError, setNearError] = useState(false)

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('focus')
    setParams(next, { replace: true })
    setNoLocationOnly(false)
  }

  useEffect(() => {
    if (!nearMode) return
    let cancelled = false
    getCurrentPosition({ maximumAge: 60000, timeout: 8000, enableHighAccuracy: false }).then((pos) => {
      if (cancelled) return
      if (pos) setNearPos(pos)
      else setNearError(true)
    })
    return () => {
      cancelled = true
    }
  }, [nearMode])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const q = new URLSearchParams()
    if (wilaya) q.set('wilaya', wilaya)
    if (category) q.set('category', category)
    if (status !== 'all') q.set('status', status)
    if (config.is_admin) q.set('include_pending', '1')
    api(`/signalements/?${q}`)
      .then((data) => !cancelled && (setItems(data || []), setError('')))
      .catch((e) => !cancelled && setError(translateApiError(e, t)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [wilaya, category, status, t, config.is_admin])

  // This device's own reports that aren't public yet (still being
  // checked): shown to their reporter as grey pins.
  useEffect(() => {
    const ids = getOwnSignalementIds().slice(-10)
    if (!ids.length) return
    let cancelled = false
    Promise.all(ids.map((id) => api(`/signalements/${id}/`).catch(() => null))).then((rows) => {
      if (!cancelled) setOwnPending(rows.filter((r) => r && r.processing_status === 'pending' && r.status !== 'cancelled'))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const focused = focusedReport && focusedReport.id === focusId ? focusedReport : null
  useEffect(() => {
    if (!focusId) return
    let cancelled = false
    api(`/signalements/${focusId}/`)
      .then((s) => !cancelled && setFocused(s))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [focusId])

  const all = useMemo(() => {
    const extra = [focused, ...ownPending].filter((x, i, arr) => x && !items.some((y) => y.id === x.id) && arr.findIndex((z) => z && z.id === x.id) === i)
    return [...extra, ...items].filter((s) => {
      if (geo === 'with' && !s.has_exact_position) return false
      if (geo === 'without' && s.has_exact_position) return false
      if (nearMode && nearPos && haversineKm(nearPos, [s.display_latitude, s.display_longitude]) > NEAR_KM) return false
      return true
    })
  }, [focused, ownPending, items, geo, nearMode, nearPos])
  const located = useMemo(() => all.filter((s) => s.has_exact_position), [all])
  const unlocated = useMemo(() => all.filter((s) => !s.has_exact_position), [all])
  // true = every report without an exact position; a wilaya id = only
  // that wilaya's (from its bubble on the map).
  const listed = noLocationOnly
    ? unlocated.filter((s) => noLocationOnly === true || String(s.wilaya) === noLocationOnly)
    : all

  // --- map ---
  const mapEl = useRef(null)
  const mapFrameRef = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const fittedRef = useRef('')
  const [mapActive, setMapActive] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [mapHeight, setMapHeight] = useState(420)

  // Same "asleep until tapped" behaviour as NeedsList.jsx/CollectionPoints.jsx:
  // one finger scrolls the page, a tap wakes the map up.
  const setInteractive = useCallback((on) => {
    const map = mapRef.current
    if (!map) return
    ;['dragging', 'touchZoom', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom'].forEach((h) => (on ? map[h].enable() : map[h].disable()))
    setMapActive(on)
  }, [])

  useEffect(() => {
    const map = L.map(mapEl.current, {
      attributionControl: false,
      center: [28, 2.6],
      zoom: 5,
      dragging: false,
      touchZoom: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      boxZoom: false,
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map)
    L.control.attribution({ prefix: false }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    attachMapTapToActivate(map, () => setInteractive(true))
    // Popup "open the report" links navigate inside the app.
    map.on('popupopen', (e) => {
      // Leaflet stops touches/presses that start on a popup, so a finger
      // sliding on it didn't move the map. Let them through to the map's
      // drag handler; taps (link, ×) still work, and clicks on the popup
      // still don't close it (_leaflet_disable_click stays set).
      const el = e.popup.getElement()
      if (el) L.DomEvent.off(el, 'mousedown touchstart', L.DomEvent.stopPropagation)
      const link = el?.querySelector('[data-signali-id]')
      if (link)
        link.onclick = (ev) => {
          ev.preventDefault()
          navigate(`/signalements/${link.dataset.signaliId}`)
        }
    })
    return () => map.remove()
  }, [setInteractive, navigate])

  const enterFullscreen = () => {
    setInteractive(true)
    setFullscreen(true)
    mapFrameRef.current?.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {})
  }
  const exitFullscreen = () => {
    if (document.fullscreenElement === mapFrameRef.current) document.exitFullscreen?.()?.catch(() => {})
    setFullscreen(false)
    setInteractive(false)
  }
  useEffect(() => {
    const onChange = () => {
      const native = document.fullscreenElement === mapFrameRef.current
      setFullscreen(native)
      if (!native) setInteractive(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [setInteractive])
  useEffect(() => {
    const id = requestAnimationFrame(() => mapRef.current?.invalidateSize())
    return () => cancelAnimationFrame(id)
  }, [fullscreen, mapHeight, viewMode])

  // The map fills the screen down to the bottom nav, like the other maps.
  // Measured against the page (not the current scroll) and only when the
  // width changes: on phones, scrolling shows/hides the browser's address
  // bar, which fires height-only resizes -- reacting to those made the
  // map grow to the whole screen height while scrolling.
  useEffect(() => {
    if (fullscreen) return
    let lastWidth = window.innerWidth
    let screenHeight = window.innerHeight
    const recompute = () => {
      const el = mapFrameRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top + window.scrollY
      setMapHeight(Math.min(760, Math.max(260, Math.round(screenHeight - top - 96))))
    }
    const onResize = () => {
      if (window.innerWidth === lastWidth) return
      lastWidth = window.innerWidth
      screenHeight = window.innerHeight
      recompute()
    }
    recompute()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fullscreen, filtersOpen, viewMode, nearMode])

  const recenterOnMe = async () => {
    const map = mapRef.current
    if (!map) return
    const pos = await getCurrentPosition({ maximumAge: 30000, timeout: 3000, enableHighAccuracy: false })
    if (!pos) return showAlert(t('map.locationUnavailable'))
    map.fitBounds(L.latLng(pos[0], pos[1]).toBounds(RECENTER_BOX_METERS))
  }

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const points = []
    located.forEach((s) => {
      const ll = [s.display_latitude, s.display_longitude]
      points.push(ll)
      const marker = L.marker(ll, { icon: pinIcon(s, s.id === focusId), zIndexOffset: s.id === focusId ? 1000 : 0, title: t(`signali.categories.${s.category}`) })
        // autoPan on (the app-wide default is off): the map shifts so the
        // popup is always fully visible, even for a pin near the edge.
        .bindPopup(popupHtml(t, s), { autoPan: true, autoPanPadding: [16, 60], maxWidth: 240 })
        .on('popupopen', (e) => {
          // Open above where the pin is *drawn* (it may have been nudged
          // aside by spreadSignaliMarkers), not its raw position.
          const [dx, dy] = marker._signaliOffset || [0, 0]
          e.popup.options.offset = L.point(dx, dy - 12)
          e.popup.update()
          // Leaflet pans for the popup before this offset applies: pan
          // again so a nudged pin's popup never hangs off the map.
          e.popup._adjustPan?.()
        })
        .addTo(layer)
      if (s.id === focusId && focused) requestAnimationFrame(() => marker.openPopup())
    })
    // Reports with no exact position: one bubble per wilaya, on that
    // wilaya's own centre (a Tizi Ouzou report sits on Tizi Ouzou, not on
    // Alger). Tapping it lists that wilaya's reports. A plain title, not
    // bindTooltip: markers are rebuilt on every selection, and an open
    // Leaflet tooltip on a removed marker throws.
    const byWilaya = new Map()
    unlocated.forEach((s) => byWilaya.set(s.wilaya, [...(byWilaya.get(s.wilaya) || []), s]))
    byWilaya.forEach((group, wilayaId) => {
      const ll = [group[0].display_latitude, group[0].display_longitude]
      L.marker(ll, { icon: bubbleIcon(group.length), zIndexOffset: 2000, title: `${t('signali.noLocationBubble')} · ${group[0].wilaya_name} (${group.length})` })
        .on('click', () => {
          setNoLocationOnly(String(wilayaId))
          setViewMode('list')
        })
        .addTo(layer)
      points.push(ll)
    })
    spreadSignaliMarkers(map)
    // Refit only when the filters (or the focused report) change, not on
    // every selection/vote -- the view shouldn't jump under the finger.
    const key = `${wilaya}|${category}|${status}|${geo}|${focused?.id || ''}|${nearPos || ''}|${loading}`
    if (fittedRef.current === key || loading) return
    fittedRef.current = key
    if (nearMode && nearPos) map.fitBounds(L.latLng(nearPos[0], nearPos[1]).toBounds(NEAR_KM * 2000))
    else if (focused?.has_exact_position) map.setView([focused.display_latitude, focused.display_longitude], 16)
    else if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 15 })
    else {
      const w = wilayas.find((x) => String(x.id) === wilaya)
      if (w?.centroid_latitude) map.setView([w.centroid_latitude, w.centroid_longitude], 9)
      else map.setView([34.5, 3], 5)
    }
  }, [located, unlocated, focusId, focused, wilaya, category, status, geo, nearMode, nearPos, loading, wilayas, t])

  return (
    <section className="signalements-page">
      <div className="toolbar toolbar-compact signalements-toolbar">
        <button type="button" className="filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
          ☰ {t('common.filters')}
          {(wilaya || category || status !== 'open' || geo !== 'all') && <span className="filters-badge" aria-hidden="true" />}
        </button>
        <Link to="/signali" className="btn btn-primary signalements-new" aria-label={t('signali.newReport')}>
          <IconPlus width={16} height={16} strokeWidth={2.6} /> {t('signali.newReport')}
        </Link>
        <div className="view-toggle">
          <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
            {t('needsList.list')}
          </button>
          <button type="button" className={viewMode === 'map' ? 'active' : ''} onClick={() => setViewMode('map')}>
            {t('needsList.map')}
          </button>
        </div>
      </div>
      {(nearMode || noLocationOnly) && (
        <div className="signalements-chips">
          {nearMode && (
            <div className="filters-badge-chip">
              📍 {nearError ? t('signali.nearUnavailable') : t('signali.nearMe', { km: NEAR_KM })}
              <button type="button" onClick={() => setFilter('near', '')} aria-label={t('common.close')}>×</button>
            </div>
          )}
          {noLocationOnly && (
            <div className="filters-badge-chip">
              {t('signali.noLocationBubble')}
              {noLocationOnly !== true && ` · ${unlocated.find((u) => String(u.wilaya) === noLocationOnly)?.wilaya_name || ''}`}
              <button type="button" onClick={() => setNoLocationOnly(false)} aria-label={t('common.close')}>×</button>
            </div>
          )}
        </div>
      )}
      {filtersOpen && (
        <div className="filters-panel signalements-filters">
          <WilayaCombobox
            wilayas={wilayas}
            value={wilaya}
            onChange={(v) => setFilter('wilaya', v)}
            placeholder={t('signali.allWilayas')}
            emptyLabel={t('signali.allWilayas')}
          />
          <select value={category} onChange={(e) => setFilter('category', e.target.value)} aria-label={t('signali.categoryLabel')}>
            <option value="">{t('signali.allCategories')}</option>
            {SIGNALI_CATEGORIES.map((c) => (
              <option key={c} value={c}>{categoryEmoji(c)} {t(`signali.categories.${c}`)}</option>
            ))}
          </select>
          <div className="signalements-status" role="group" aria-label={t('signali.statusLabel')}>
            {['open', 'resolved', 'all'].map((v) => (
              <button key={v} type="button" className={status === v ? 'selected' : ''} onClick={() => setFilter('status', v === 'open' ? '' : v)}>
                {t(`signali.filterStatus.${v}`)}
              </button>
            ))}
          </div>
          <div className="signalements-status" role="group" aria-label={t('signali.geoLabel')}>
            {['all', 'with', 'without'].map((v) => (
              <button key={v} type="button" className={geo === v ? 'selected' : ''} onClick={() => setFilter('geo', v === 'all' ? '' : v)}>
                {t(`signali.filterGeo.${v}`)}
              </button>
            ))}
          </div>
          <span className="signalements-count">{t('signali.countTotal', { count: all.length })}</span>
        </div>
      )}

      <div className="map-wrap" hidden={viewMode !== 'map'}>
        <div
          ref={mapFrameRef}
          className={`map-frame signalements-map-frame${fullscreen ? ' map-frame-fullscreen' : ''}`}
          style={fullscreen ? undefined : { height: mapHeight }}
        >
          <div ref={mapEl} className="signalements-map" style={{ height: '100%' }} />
          {!loading && !all.length && <div className="signalements-empty">{t('signali.empty')}</div>}
          {!mapActive && !fullscreen && (
            <div className="map-activate-overlay map-activate-hint-only">
              <span className="map-activate-hint">{t('map.tapToInteract')}</span>
            </div>
          )}
          {mapActive && !fullscreen && (
            <button type="button" className="map-deactivate-btn" onClick={() => setInteractive(false)}>
              {t('map.exitMapInteraction')}
            </button>
          )}
          {!fullscreen ? (
            <button type="button" className="expand-btn" onClick={enterFullscreen} aria-label={t('map.viewFullscreen')} title={t('map.viewFullscreen')}>
              <IconExpand width={18} height={18} />
            </button>
          ) : (
            <button type="button" className="exit-fullscreen-btn" onClick={exitFullscreen} aria-label={t('map.exitFullscreen')} title={t('map.exitFullscreen')}>
              <IconClose width={20} height={20} />
            </button>
          )}
          <button type="button" className="locate-btn" onClick={recenterOnMe} aria-label={t('map.recenterOnMe')} title={t('map.recenterOnMe')}>
            <IconLocate width={18} height={18} />
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      {viewMode === 'list' && !listed.length && !loading && <p className="hint">{t('signali.empty')}</p>}
      {viewMode === 'list' && !!listed.length && (
        <ul className="signalements-list">
          {noLocationOnly && <li className="signalements-list-title">📍 {t('signali.noLocationBubble')}</li>}
          {listed.map((s) => {
            return (
              <li key={s.id}>
                <Link to={`/signalements/${s.id}`}>
                  <Thumb s={s} size="sm" />
                  <span>
                    <b>{t(`signali.categories.${s.category}`)}</b>
                    <small>{[s.address || s.commune, s.wilaya_name].filter(Boolean).join(' · ')}</small>
                    {s.has_exact_position ? (
                      <i className="signali-geo-badge">📍 {t('signali.geolocated')}</i>
                    ) : (
                      <i className="signali-geo-badge is-approx">{t('signali.approxLocation')}</i>
                    )}
                  </span>
                  <em>👍 {s.confirmations_count + 1}</em>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
