import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { translateApiError } from '../apiErrors'
import { formatDate, getCurrentPosition, RECENTER_BOX_METERS } from '../utils'
import { attachMapTapToActivate } from '../mapMarkers'
import { IconClose, IconExpand, IconLocate, IconPlus } from '../icons'
import WilayaCombobox from '../components/WilayaCombobox'
import { SIGNALI_CATEGORIES, categoryEmoji, getOwnSignalementIds } from '../signali'
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
// fullscreen, "center on me", and a map that fills the screen. Reports
// still being checked show as grey pins to their own reporter (this
// device's tokens) and to admins.

function pinIcon(s, selected) {
  const open = s.status === 'new' || s.status === 'in_review'
  const cls = [
    'signali-marker',
    open ? 'is-open' : 'is-resolved',
    s.processing_status === 'pending' ? 'is-pending' : '',
    selected ? 'is-selected' : '',
  ].join(' ')
  return L.divIcon({ className: 'signali-marker-icon', html: `<span class="${cls}">${categoryEmoji(s.category)}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] })
}

// The "Signal" megaphone (same drawing as IconMegaphone in icons.jsx,
// used for the bottom-nav tab), as a plain string for Leaflet's divIcon.
const SIGNAL_ICON_SVG =
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3.5 10.2v3.6a1 1 0 0 0 1 1H7l7.5 4.2V5L7 9.2H4.5a1 1 0 0 0-1 1Z"/><path d="M7.5 14.8 9 20h2.3"/>' +
  '<path d="M18 9.2a4 4 0 0 1 0 5.6M20.3 7a7.2 7.2 0 0 1 0 10"/></svg>'

// Pins and bubbles that land (almost) on the same spot are nudged apart
// on screen so each stays visible and tappable -- same idea as
// mapMarkers.spreadNeedMarkers, with a wider spread since several
// reports often share one wilaya centre. Re-run on every zoom.
const SPREAD_MIN_PX = 44
const SPREAD_MAX_PX = 60
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
    el.style.translate = `${clamp(off[i].x)}px ${clamp(off[i].y)}px`
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
        <span className="signali-thumb-icon" aria-hidden="true">{categoryEmoji(s.category)}</span>
      )}
      {(photo || s.video_file) && <span className="signali-thumb-badge" aria-hidden="true">{categoryEmoji(s.category)}</span>}
    </span>
  )
}

function Preview({ s }) {
  const { t, i18n } = useTranslation()
  return (
    <Link to={`/signalements/${s.id}`} className="signalements-preview">
      <Thumb s={s} size="lg" />
      <span>
        <b>{t(`signali.categories.${s.category}`)}</b>
        <small>{[s.address || s.commune, s.wilaya_name].filter(Boolean).join(' · ')}</small>
        <small>{formatDate(s.created_at, i18n.language)} · {t(`signali.status.${s.status}`)}</small>
        {s.description && <small className="signalements-preview-text">{s.description}</small>}
      </span>
      <em>{t('signali.openReport')} →</em>
    </Link>
  )
}

export default function Signalements() {
  const { t } = useTranslation()
  const { wilayas, config } = useApp()
  const { showAlert } = useDialog()
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
  const [selectedId, setSelectedId] = useState(focusId)

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('focus')
    setParams(next, { replace: true })
    setNoLocationOnly(false)
  }

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
    return [...extra, ...items]
  }, [focused, ownPending, items])
  const located = useMemo(() => all.filter((s) => s.has_exact_position), [all])
  const unlocated = useMemo(() => all.filter((s) => !s.has_exact_position), [all])
  const selected = all.find((x) => x.id === selectedId) || null
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
    return () => map.remove()
  }, [setInteractive])

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
  useEffect(() => {
    if (fullscreen) return
    const recompute = () => {
      const el = mapFrameRef.current
      if (!el) return
      setMapHeight(Math.max(260, Math.round(window.innerHeight - el.getBoundingClientRect().top - 100)))
    }
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  }, [fullscreen, filtersOpen, selectedId, viewMode])

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
      L.marker(ll, { icon: pinIcon(s, s.id === selectedId), zIndexOffset: s.id === selectedId ? 1000 : 0, title: t(`signali.categories.${s.category}`) })
        .on('click', () => {
          setSelectedId(s.id)
          setNoLocationOnly(false)
        })
        .addTo(layer)
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
          setSelectedId(null)
          setViewMode('list')
        })
        .addTo(layer)
      points.push(ll)
    })
    spreadSignaliMarkers(map)
    // Refit only when the filters (or the focused report) change, not on
    // every selection/vote -- the view shouldn't jump under the finger.
    const key = `${wilaya}|${category}|${status}|${focused?.id || ''}|${loading}`
    if (fittedRef.current === key || loading) return
    fittedRef.current = key
    if (focused?.has_exact_position) map.setView([focused.display_latitude, focused.display_longitude], 16)
    else if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 15 })
    else {
      const w = wilayas.find((x) => String(x.id) === wilaya)
      if (w?.centroid_latitude) map.setView([w.centroid_latitude, w.centroid_longitude], 9)
      else map.setView([34.5, 3], 5)
    }
  }, [located, unlocated, selectedId, focused, wilaya, category, status, loading, wilayas, t])

  return (
    <section className="signalements-page">
      <div className="signalements-head">
        <h1>📣 {t('signali.listTitle')}</h1>
        <Link to="/signali" className="btn btn-primary signalements-new">
          <IconPlus width={16} height={16} strokeWidth={2.6} /> {t('signali.newReport')}
        </Link>
      </div>

      <div className="toolbar toolbar-compact signalements-toolbar">
        <button type="button" className="filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
          ☰ {t('common.filters')}
          {(wilaya || category || status !== 'open') && <span className="filters-badge" aria-hidden="true" />}
        </button>
        {noLocationOnly && (
          <div className="filters-badge-chip">
            {t('signali.noLocationBubble')}
            {noLocationOnly !== true && ` · ${unlocated.find((u) => String(u.wilaya) === noLocationOnly)?.wilaya_name || ''}`}
            <button type="button" onClick={() => setNoLocationOnly(false)} aria-label={t('common.close')}>×</button>
          </div>
        )}
        <span className="signalements-count">{t('signali.countTotal', { count: all.length })}</span>
        <div className="view-toggle">
          <button type="button" className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')}>
            {t('needsList.list')}
          </button>
          <button type="button" className={viewMode === 'map' ? 'active' : ''} onClick={() => setViewMode('map')}>
            {t('needsList.map')}
          </button>
        </div>
      </div>
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
          <div className="signalements-status" role="group">
            {['open', 'resolved', 'all'].map((v) => (
              <button key={v} type="button" className={status === v ? 'selected' : ''} onClick={() => setFilter('status', v === 'open' ? '' : v)}>
                {t(`signali.filterStatus.${v}`)}
              </button>
            ))}
          </div>
          {unlocated.length > 0 && (
            <button type="button" className={`signali-link${noLocationOnly ? ' is-active' : ''}`} onClick={() => setNoLocationOnly((v) => !v)}>
              📍 {t('signali.countNoLocation', { count: unlocated.length })}
            </button>
          )}
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

      {viewMode === 'map' && selected && <Preview s={selected} />}

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
