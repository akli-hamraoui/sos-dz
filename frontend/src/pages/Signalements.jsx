import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { translateApiError } from '../apiErrors'
import { getCurrentPosition, haversineKm } from '../utils'
import { IconLocate, IconPlus } from '../icons'
import WilayaCombobox from '../components/WilayaCombobox'
import { SIGNALI_CATEGORIES, SIGNAL_ICON_SVG, categoryEmoji, categoryIconHtml, getOwnSignalementIds } from '../signali'
import CategoryIcon from '../components/CategoryIcon'
import '../signali.css'

// The Signali map, "explore" style (like Airbnb): the map fills the screen
// and the reports *visible in it* scroll in a carousel at the bottom --
// sliding a card lights up its pin, tapping a pin brings its card, tapping
// a card opens the report (SignalementDetail.jsx). Panning/zooming or
// changing a filter refreshes the carousel, the list and the "N in this
// area" count right away. Zoomed out, nearby pins merge into numbered
// clusters (tap = zoom in). On a wide screen the list sits next to the
// map instead of the carousel; on a phone, "Liste" slides it over the map.
// Reports with no exact position are grouped in one bubble per wilaya, on
// its centre. ?focus=<id> centers on one report, ?near=1 on the visitor
// (30 km). Filters (wilaya, type, status, geolocation) live in the URL.

const NEAR_KM = 30
const CLUSTER_PX = 54 // pins closer than this on screen merge...
const CLUSTER_UNTIL_ZOOM = 15 // ...up to this zoom; closer in, every report has its own pin
const WIDE_QUERY = '(min-width: 900px)'
const CAROUSEL_MAX = 40
const VIEW_KEY = 'signalementsView'

function pinIcon(s, highlighted) {
  const open = s.status === 'new' || s.status === 'in_review'
  const cls = ['signali-marker', open ? 'is-open' : 'is-resolved', highlighted ? 'is-selected' : ''].join(' ')
  const size = highlighted ? 48 : 34
  return L.divIcon({
    className: 'signali-marker-icon',
    html: `<span class="${cls}">${categoryIconHtml(s.category)}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function clusterIcon(count, highlighted) {
  const size = count < 10 ? 44 : count < 50 ? 52 : 60
  return L.divIcon({
    className: 'signali-marker-icon',
    html: `<span class="sx-cluster${highlighted ? ' is-selected' : ''}" style="width:${size}px;height:${size}px">${count}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function bubbleIcon(count) {
  return L.divIcon({
    className: 'signali-marker-icon',
    html: `<span class="signali-bubble">${SIGNAL_ICON_SVG}<b>${count}</b></span>`,
    iconSize: [64, 64],
    iconAnchor: [32, 32],
  })
}

// Greedy on-screen clustering, recomputed on every zoom: a report joins
// the first group whose pin is within CLUSTER_PX, else starts its own.
function clusterReports(map, reports) {
  const zoom = map.getZoom()
  const groups = []
  reports.forEach((s) => {
    const ll = L.latLng(s.display_latitude, s.display_longitude)
    const pt = map.project(ll, zoom)
    const group = zoom <= CLUSTER_UNTIL_ZOOM && groups.find((g) => g.pt.distanceTo(pt) < CLUSTER_PX)
    if (group) {
      group.items.push(s)
      group.bounds.extend(ll)
    } else groups.push({ pt, ll, items: [s], bounds: L.latLngBounds(ll, ll) })
  })
  return groups
}

// Zoomed all the way in, reports on the very same spot are nudged apart on
// screen so each pin stays tappable.
const SPREAD_MIN_PX = 44
function spreadMarkers(markers, map) {
  const pos = markers.map((m) => map.latLngToContainerPoint(m.getLatLng()))
  const off = markers.map(() => ({ x: 0, y: 0 }))
  for (let pass = 0; pass < 6; pass += 1) {
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
    const el = m._icon?.firstElementChild
    if (el) el.style.translate = `${Math.round(off[i].x)}px ${Math.round(off[i].y)}px`
  })
}

const formatKm = (km) => (km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m` : `${km.toFixed(km < 10 ? 1 : 0).replace('.', ',')} km`)

// A report's picture: its first photo, else a frame of its video (▶),
// else its category's icon -- with the category as a corner badge.
function Thumb({ s }) {
  const photo = s.photos.find((p) => p.image)?.image
  return (
    <span className="sx-thumb">
      {photo ? (
        <img src={photo} alt="" loading="lazy" />
      ) : s.video_file ? (
        <>
          <video src={`${s.video_file}#t=0.5`} muted playsInline preload="metadata" />
          <span className="sx-thumb-play" aria-hidden="true">▶</span>
        </>
      ) : (
        <CategoryIcon category={s.category} className="sx-thumb-icon" />
      )}
      {(photo || s.video_file) && <CategoryIcon category={s.category} className="sx-thumb-badge" />}
    </span>
  )
}

function ReportCard({ s, t, i18n, distance, selected, compact, onHover }) {
  const text = (s.description || s.voice_transcript || '').trim()
  const open = s.status === 'new' || s.status === 'in_review'
  return (
    <Link
      to={`/signalements/${s.id}`}
      data-id={s.id}
      className={`sx-card${selected ? ' is-selected' : ''}${compact ? ' is-compact' : ''}`}
      onMouseEnter={onHover ? () => onHover(s.id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <Thumb s={s} />
      <span className="sx-card-info">
        <b>{t(`signali.categories.${s.category}`)}</b>
        <small>{[s.address || s.commune, s.wilaya_name].filter(Boolean).join(' · ')}</small>
        {!compact && text && <span className="sx-card-text">{text}</span>}
        <span className="sx-card-meta">
          <span>👍 {s.confirmations_count + 1}</span>
          {distance != null ? <span>📍 {formatKm(distance)}</span> : <span>{new Date(s.created_at).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })}</span>}
          <span className={`sx-badge${open ? '' : ' is-fixed'}`}>{t(`signali.status.${s.status}`)}</span>
          {!s.has_exact_position && <span className="sx-badge is-approx">{t('signali.approxLocation')}</span>}
        </span>
      </span>
    </Link>
  )
}

export default function Signalements() {
  const { t, i18n } = useTranslation()
  const { wilayas, config } = useApp()
  const { showAlert } = useDialog()
  const [params, setParams] = useSearchParams()
  const [filtersOpen, setFiltersOpen] = useState(false)
  // Phone: the list is a bottom sheet -- 'half' (start: map above, list
  // below), 'full', 'peek' (just its header) -- or 'card' after a pin tap
  // (sheet down, that report's card in a carousel). Drag the handle.
  const [sheet, setSheet] = useState(() => (Number(new URLSearchParams(window.location.search).get('focus')) ? 'card' : 'half'))
  const sheetModeRef = useRef(sheet)
  useEffect(() => {
    sheetModeRef.current = sheet
  }, [sheet])
  const [ownPending, setOwnPending] = useState([])
  const [items, setItems] = useState([])
  const [focusedReport, setFocused] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [noLocationOnly, setNoLocationOnly] = useState('')
  const [viewIds, setViewIds] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [hoveredId, setHoveredId] = useState(null)
  const [myPos, setMyPos] = useState(null)
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE_QUERY).matches ?? false)
  const [height, setHeight] = useState(560)

  const wilaya = params.get('wilaya') || ''
  const category = params.get('category') || ''
  const status = params.get('status') || 'open'
  const focusId = Number(params.get('focus')) || null
  const geo = params.get('geo') || 'all'
  const nearMode = params.get('near') === '1'
  const [nearPos, setNearPos] = useState(null)
  const [nearError, setNearError] = useState(false)

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('focus')
    setParams(next, { replace: true })
    setNoLocationOnly('')
  }

  useEffect(() => {
    const mq = window.matchMedia?.(WIDE_QUERY)
    if (!mq) return
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!nearMode) return
    let cancelled = false
    getCurrentPosition({ maximumAge: 60000, timeout: 8000, enableHighAccuracy: false }).then((pos) => {
      if (cancelled) return
      if (pos) {
        setNearPos(pos)
        setMyPos(pos)
      } else setNearError(true)
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

  // This device's own reports not yet in the public list.
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
  const byId = useMemo(() => new Map(all.map((s) => [s.id, s])), [all])
  const located = useMemo(() => all.filter((s) => s.has_exact_position), [all])
  const unlocated = useMemo(() => all.filter((s) => !s.has_exact_position), [all])

  // What the carousel / list show: the reports inside the map's current
  // view, nearest to its centre first -- or one wilaya's "no location" ones.
  const shown = useMemo(() => {
    if (noLocationOnly) return unlocated.filter((s) => String(s.wilaya) === noLocationOnly)
    return viewIds.map((id) => byId.get(id)).filter(Boolean)
  }, [noLocationOnly, unlocated, viewIds, byId])
  const distanceOf = (s) => (myPos ? haversineKm(myPos, [s.display_latitude, s.display_longitude]) : null)

  // --- layout: the explore view fills the screen down to the bottom nav ---
  const rootRef = useRef(null)
  // Full-bleed while this page is shown: no page margins, footer or back
  // button, so nothing scrolls but the map, the carousel and the list.
  useEffect(() => {
    document.body.classList.add('sx-explore-page')
    return () => document.body.classList.remove('sx-explore-page')
  }, [])
  useEffect(() => {
    window.scrollTo(0, 0)
    let lastWidth = -1
    const measure = () => {
      if (window.innerWidth === lastWidth) return // phones fire height-only resizes while scrolling
      lastWidth = window.innerWidth
      const el = rootRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top + window.scrollY
      const nav = document.querySelector('.bottom-nav')
      const navH = nav && getComputedStyle(nav).display !== 'none' ? nav.offsetHeight : 0
      setHeight(Math.max(380, Math.round(window.innerHeight - top - navH)))
    }
    const onRotate = () => {
      lastWidth = -1
      measure()
    }
    measure()
    window.addEventListener('resize', measure)
    window.addEventListener('orientationchange', onRotate)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('orientationchange', onRotate)
    }
  }, [])

  // --- map ---
  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const meRef = useRef(null)
  const groupsRef = useRef([]) // [{ marker, items, single, lit }]
  const fittedRef = useRef('')
  const quietMoveRef = useRef(false) // a pan we made for the carousel: keep its order
  const freshViewRef = useRef(false) // the user moved the map: restart the carousel
  const coverRef = useRef(0) // px of map hidden under the phone's list sheet
  const carouselRef = useRef(null)
  const listRef = useRef(null)
  const filterKeyRef = useRef('')
  useEffect(() => {
    filterKeyRef.current = `${wilaya}|${category}|${status}|${geo}||`
  }, [wilaya, category, status, geo])
  const allRef = useRef(all)
  useEffect(() => {
    allRef.current = all
  }, [all])
  const [zoomTick, setZoomTick] = useState(0)

  const refreshView = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    // Only the part of the map not hidden under the phone's list sheet.
    const size = map.getSize()
    const visibleH = Math.max(80, size.y - coverRef.current)
    const bounds = L.latLngBounds(map.containerPointToLatLng([0, 0]), map.containerPointToLatLng([size.x, visibleH]))
    const center = map.containerPointToLatLng([size.x / 2, visibleH / 2])
    const inView = allRef.current
      .filter((s) => bounds.contains([s.display_latitude, s.display_longitude]))
      .map((s) => [s, center.distanceTo([s.display_latitude, s.display_longitude]) + (s.has_exact_position ? 0 : 1e7)])
      .sort((a, b) => a[1] - b[1])
      .map(([s]) => s.id)
    freshViewRef.current = true
    setViewIds(inView)
  }, [])

  useEffect(() => {
    const map = L.map(mapEl.current, { attributionControl: false, zoomControl: false, center: [28, 2.6], zoom: 5 })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map)
    L.control.attribution({ prefix: false, position: 'topright' }).addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    map.on('zoomend', () => setZoomTick((n) => n + 1))
    // A tap on the map itself (not a pin) puts the card away.
    map.on('click', () => {
      if (sheetModeRef.current === 'card') {
        setSheet('peek')
        setSelectedId(null)
      }
    })
    map.on('moveend', () => {
      try {
        const c = map.getCenter()
        // Not before the first fit: the initial resize would save the
        // default whole-Algeria view over the one to restore.
        if (fittedRef.current) sessionStorage.setItem(VIEW_KEY, JSON.stringify({ f: filterKeyRef.current, c: [c.lat, c.lng], z: map.getZoom() }))
      } catch {
        /* private mode: the view just isn't remembered */
      }
      if (quietMoveRef.current) {
        quietMoveRef.current = false
        return
      }
      refreshView()
    })
    return () => map.remove()
  }, [refreshView])

  useEffect(() => {
    mapRef.current?.invalidateSize()
  }, [height, wide])

  // Highlight the selected/hovered report's pin (or the cluster holding it)
  // without rebuilding every marker.
  const lit = hoveredId || selectedId
  const litRef = useRef(lit)
  useEffect(() => {
    litRef.current = lit
  }, [lit])
  const lightMarkers = useCallback(() => {
    const map = mapRef.current
    let moved = false
    groupsRef.current.forEach((g) => {
      const on = g.items.some((s) => s.id === litRef.current)
      if (on === g.lit) return
      g.lit = on
      g.marker.setIcon(g.single ? pinIcon(g.items[0], on) : clusterIcon(g.items.length, on))
      g.marker.setZIndexOffset(on ? 1500 : 0)
      moved = true
    })
    if (moved && map && map.getZoom() > CLUSTER_UNTIL_ZOOM) spreadMarkers(groupsRef.current.filter((x) => x.single).map((x) => x.marker), map)
  }, [])
  useEffect(() => lightMarkers(), [lit, lightMarkers])

  // Markers: rebuilt on data or zoom change (clusters depend on the zoom).
  const selectRef = useRef(() => {})
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const groups = []
    clusterReports(map, located).forEach((g) => {
      const single = g.items.length === 1
      const marker = L.marker(g.ll, {
        icon: single ? pinIcon(g.items[0], false) : clusterIcon(g.items.length, false),
        title: single ? t(`signali.categories.${g.items[0].category}`) : String(g.items.length),
      })
        .on('click', () => {
          if (single) selectRef.current(g.items[0].id, 'map')
          else map.fitBounds(g.bounds.pad(0.4), { maxZoom: CLUSTER_UNTIL_ZOOM + 2 })
        })
        .addTo(layer)
      groups.push({ marker, items: g.items, single, lit: false })
    })
    // No exact position: one bubble per wilaya, on its centre; tapping it
    // lists that wilaya's ones.
    const byWilaya = new Map()
    unlocated.forEach((s) => byWilaya.set(s.wilaya, [...(byWilaya.get(s.wilaya) || []), s]))
    byWilaya.forEach((group, wilayaId) => {
      L.marker([group[0].display_latitude, group[0].display_longitude], {
        icon: bubbleIcon(group.length),
        zIndexOffset: 2000,
        title: `${t('signali.noLocationBubble')} · ${group[0].wilaya_name} (${group.length})`,
      })
        .on('click', () => {
          setNoLocationOnly(String(wilayaId))
          setSelectedId(group[0].id)
        })
        .addTo(layer)
    })
    groupsRef.current = groups
    if (map.getZoom() > CLUSTER_UNTIL_ZOOM) spreadMarkers(groups.filter((g) => g.single).map((g) => g.marker), map)
    lightMarkers()
    refreshView()
  }, [located, unlocated, zoomTick, t, refreshView, lightMarkers])

  // Me (after "center on me" / near mode).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !myPos) return
    meRef.current?.remove()
    meRef.current = L.circleMarker(myPos, { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(map)
  }, [myPos])

  // Phone list sheet: its snap heights, and how much map it hides.
  const snaps = { full: 0, half: Math.round(height * 0.5), peek: height - 74 }
  const sheetTop = sheet === 'card' ? height : snaps[sheet]
  // The map area the sheet hides (none in full: the map isn't seen then).
  const cover = wide || sheet === 'card' || sheet === 'full' ? 0 : height - sheetTop
  useEffect(() => {
    if (coverRef.current === cover) return
    coverRef.current = cover
    refreshView()
  }, [cover, refreshView])

  // Refit when the filters (or the focused report) change -- not on
  // every selection, the view mustn't jump under the finger.
  useEffect(() => {
    const map = mapRef.current
    if (!map || loading) return
    const key = `${wilaya}|${category}|${status}|${geo}|${focused?.id || ''}|${nearPos || ''}`
    if (fittedRef.current === key) return
    const firstFit = !fittedRef.current
    fittedRef.current = key
    // Back from a report ("Retour"): same place as before, same filters.
    if (firstFit && !focusId && !nearMode) {
      try {
        const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null')
        if (saved?.f === key && saved.c) {
          map.setView(saved.c, saved.z)
          return
        }
      } catch {
        /* nothing saved */
      }
    }
    const points = all.map((s) => [s.display_latitude, s.display_longitude])
    const pad = { paddingBottomRight: [0, coverRef.current] }
    if (nearMode && nearPos) map.fitBounds(L.latLng(nearPos[0], nearPos[1]).toBounds(NEAR_KM * 2000), pad)
    else if (focused) {
      map.setView([focused.display_latitude, focused.display_longitude], focused.has_exact_position ? 16 : 11)
      setSelectedId(focused.id)
    } else if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 15, ...pad })
    else {
      const w = wilayas.find((x) => String(x.id) === wilaya)
      if (w?.centroid_latitude) map.setView([w.centroid_latitude, w.centroid_longitude], 9)
      else map.setView([34.5, 3], 5)
    }
  }, [all, loading, wilaya, category, status, geo, focused, focusId, nearMode, nearPos, wilayas])

  // --- selection: pin <-> carousel card / list card ---
  const scrollCardIntoView = (id) => {
    const box = wide ? listRef.current : carouselRef.current
    const card = box?.querySelector(`[data-id="${id}"]`)
    if (!box || !card) return
    if (wide) box.scrollTo({ top: card.offsetTop - box.clientHeight / 2 + card.clientHeight / 2, behavior: 'smooth' })
    else box.scrollTo({ left: card.offsetLeft - (box.clientWidth - card.clientWidth) / 2, behavior: 'smooth' })
  }
  const select = (id, source) => {
    setSelectedId(id)
    if (source === 'map') {
      if (!wide) setSheet('card')
      if (noLocationOnly && !shown.some((s) => s.id === id)) setNoLocationOnly('')
      requestAnimationFrame(() => requestAnimationFrame(() => scrollCardIntoView(id)))
      return
    }
    // From the carousel: bring its pin into view if it's hidden behind the
    // top bar / the carousel, without re-sorting the carousel.
    const map = mapRef.current
    const s = byId.get(id)
    if (!map || !s) return
    const pt = map.latLngToContainerPoint([s.display_latitude, s.display_longitude])
    const size = map.getSize()
    const bottomReserve = wide ? 40 : 190
    if (pt.x < 40 || pt.x > size.x - 40 || pt.y < 110 || pt.y > size.y - bottomReserve) {
      quietMoveRef.current = true
      map.panInside([s.display_latitude, s.display_longitude], { paddingTopLeft: [40, 110], paddingBottomRight: [40, bottomReserve] })
    }
  }
  useEffect(() => {
    selectRef.current = select
  })

  // Sliding the carousel selects the card that settles in the middle.
  const scrollTimer = useRef(0)
  const onCarouselScroll = () => {
    clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => {
      const box = carouselRef.current
      if (!box) return
      const mid = box.getBoundingClientRect().left + box.clientWidth / 2
      let best = null
      let bestD = Infinity
      box.querySelectorAll('[data-id]').forEach((card) => {
        const r = card.getBoundingClientRect()
        const d = Math.abs(r.left + r.width / 2 - mid)
        if (d < bestD) {
          best = Number(card.dataset.id)
          bestD = d
        }
      })
      if (best && best !== selectedId) select(best, 'carousel')
    }, 120)
  }

  // A fresh set of cards (the map was moved/zoomed, a filter changed):
  // start again from the first card -- the report nearest the centre --
  // unless the map moved only to show the selected card's pin.
  const shownKey = shown.map((s) => s.id).join(',')
  const firstShown = shown[0]?.id
  const selectedShown = shown.some((s) => s.id === selectedId)
  useEffect(() => {
    if (wide || sheet !== 'card' || !firstShown) return
    if (!freshViewRef.current && selectedShown) return
    freshViewRef.current = false
    if (focusId && selectedShown) {
      // ?focus=: keep that report, its card in the middle
      requestAnimationFrame(() => scrollCardIntoView(selectedId))
      return
    }
    setSelectedId(firstShown)
    carouselRef.current?.scrollTo({ left: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollCardIntoView reads refs only
  }, [shownKey, firstShown, selectedShown, wide, focusId, sheet])

  const recenterOnMe = async () => {
    const map = mapRef.current
    if (!map) return
    const pos = await getCurrentPosition({ maximumAge: 30000, timeout: 5000, enableHighAccuracy: false })
    if (!pos) return showAlert(t('map.locationUnavailable'))
    setMyPos(pos)
    map.setView(pos, Math.max(map.getZoom(), 14))
  }
  const showAll = () => {
    setNoLocationOnly('')
    const points = all.map((s) => [s.display_latitude, s.display_longitude])
    if (points.length) mapRef.current?.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 15 })
  }

  const wilayaName = wilayas.find((w) => String(w.id) === wilaya)?.name
  const activeChips = [
    nearMode && { key: 'near', label: `📍 ${nearError ? t('signali.nearUnavailable') : t('signali.nearMe', { km: NEAR_KM })}`, clear: () => setFilter('near', '') },
    wilayaName && { key: 'wilaya', label: wilayaName, clear: () => setFilter('wilaya', '') },
    category && {
      key: 'category',
      label: (
        <>
          <CategoryIcon category={category} /> {t(`signali.categories.${category}`)}
        </>
      ),
      clear: () => setFilter('category', ''),
    },
    status !== 'open' && { key: 'status', label: t(`signali.filterStatus.${status}`), clear: () => setFilter('status', '') },
    geo !== 'all' && { key: 'geo', label: t(`signali.filterGeo.${geo}`), clear: () => setFilter('geo', '') },
    noLocationOnly && {
      key: 'noloc',
      label: `${t('signali.noLocationBubble')} · ${unlocated.find((u) => String(u.wilaya) === noLocationOnly)?.wilaya_name || ''}`,
      clear: () => setNoLocationOnly(''),
    },
  ].filter(Boolean)
  const filterCount = activeChips.filter((c) => c.key !== 'noloc' && c.key !== 'near').length

  const countLabel = loading ? t('common.loading') : t('signali.inArea', { count: shown.length })
  const empty = !loading && !shown.length && (
    <div className="sx-empty">
      <span>{all.length ? t('signali.noneInArea') : t('signali.empty')}</span>
      {!!all.length && (
        <button type="button" className="sx-pill is-dark" onClick={showAll}>
          {t('signali.showAll')}
        </button>
      )}
    </div>
  )
  const listHead = (
    <div className="sx-list-head">
      <h2>{countLabel}</h2>
      {myPos && <small>{t('signali.sortedByDistance')}</small>}
    </div>
  )
  const listBody = (
    <>
      {empty}
      <div className="sx-list-grid">
        {shown.map((s) => (
          <ReportCard key={s.id} s={s} t={t} i18n={i18n} distance={distanceOf(s)} selected={s.id === lit} onHover={wide ? setHoveredId : undefined} compact={!wide} />
        ))}
      </div>
    </>
  )

  // --- phone bottom sheet: drag on its handle ---
  const sheetRef = useRef(null)
  const dragRef = useRef(null)
  const onSheetDown = (e) => {
    dragRef.current = { y: e.clientY, top: sheetTop, t: performance.now(), moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onSheetMove = (e) => {
    const d = dragRef.current
    const el = sheetRef.current
    if (!d || !el) return
    const dy = e.clientY - d.y
    if (Math.abs(dy) > 4) d.moved = true
    if (!d.moved) return
    el.style.transition = 'none'
    el.style.top = `${Math.min(snaps.peek, Math.max(snaps.full, d.top + dy))}px`
  }
  const onSheetUp = (e) => {
    const d = dragRef.current
    const el = sheetRef.current
    dragRef.current = null
    if (!d || !el) return
    const order = ['full', 'half', 'peek']
    let target
    if (!d.moved) {
      // A tap on the handle: peek -> half -> full -> half.
      target = sheet === 'peek' ? 'half' : sheet === 'half' ? 'full' : 'half'
    } else {
      // Where the sheet would coast to with the finger's speed, then the
      // nearest snap height to that.
      const dy = e.clientY - d.y
      const speed = dy / Math.max(1, performance.now() - d.t) // px/ms, + = down
      const projected = d.top + dy + speed * 180
      target = order.reduce((a, b) => (Math.abs(snaps[b] - projected) < Math.abs(snaps[a] - projected) ? b : a))
    }
    el.style.transition = ''
    el.style.top = `${snaps[target]}px`
    setSheet(target)
  }

  return (
    <section className="signalements-page is-explore">
      <div ref={rootRef} className={`sx${wide ? ' is-wide' : ''}`} style={{ height }}>
        {wide && (
          <aside className="sx-side" ref={listRef}>
            <div className="sx-list-inner">
              {listHead}
              {listBody}
            </div>
          </aside>
        )}
        <div className="sx-map-wrap">
          <div ref={mapEl} className="sx-map" />

          <div className="sx-top">
            <div className="sx-bar">
              <button type="button" className={`sx-pill${filtersOpen ? ' is-dark' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
                ☰ {t('common.filters')}
                {filterCount > 0 && <b className="sx-pill-count">{filterCount}</b>}
              </button>
              <span className="sx-pill is-count" role="status">{loading ? '…' : t('signali.inAreaShort', { count: shown.length })}</span>
              <Link to="/signali" className="sx-pill is-primary" aria-label={t('signali.newReport')}>
                <IconPlus width={15} height={15} strokeWidth={2.8} /> {t('signali.newReport')}
              </Link>
            </div>
            {!!activeChips.length && (
              <div className="sx-chips">
                {activeChips.map((c) => (
                  <span key={c.key} className="sx-chip">
                    {c.label}
                    <button type="button" onClick={c.clear} aria-label={t('common.close')}>×</button>
                  </span>
                ))}
              </div>
            )}
            {filtersOpen && (
              <div className="sx-filters signalements-filters">
                <WilayaCombobox wilayas={wilayas} value={wilaya} onChange={(v) => setFilter('wilaya', v)} placeholder={t('signali.allWilayas')} emptyLabel={t('signali.allWilayas')} />
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
                <button type="button" className="sx-pill is-dark sx-filters-done" onClick={() => setFiltersOpen(false)}>
                  {t('signali.showResults', { count: all.length })}
                </button>
              </div>
            )}
          </div>

          <div className="sx-fabs">
            <button type="button" className="sx-fab" onClick={recenterOnMe} aria-label={t('map.recenterOnMe')} title={t('map.recenterOnMe')}>
              <IconLocate width={18} height={18} />
            </button>
          </div>
          {error && <p className="sx-error">{error}</p>}

          {!wide && (
            <>
              {sheet === 'card' && (
                <>
                  <button type="button" className="sx-pill is-dark sx-list-toggle" onClick={() => setSheet('half')}>
                    ☰ {t('signali.listCount', { count: shown.length })}
                  </button>
                  <div className="sx-carousel" ref={carouselRef} onScroll={onCarouselScroll}>
                    {empty}
                    {shown.slice(0, CAROUSEL_MAX).map((s) => (
                      <ReportCard key={s.id} s={s} t={t} i18n={i18n} distance={distanceOf(s)} selected={s.id === selectedId} />
                    ))}
                  </div>
                </>
              )}
              <div ref={sheetRef} className={`sx-sheet is-${sheet}`} style={{ top: sheetTop }}>
                <div className="sx-sheet-grab" onPointerDown={onSheetDown} onPointerMove={onSheetMove} onPointerUp={onSheetUp} onPointerCancel={onSheetUp}>
                  <span className="sx-sheet-handle" aria-hidden="true" />
                  {listHead}
                </div>
                <div className="sx-sheet-body">{listBody}</div>
                {sheet === 'full' && (
                  <button type="button" className="sx-pill is-dark sx-map-toggle" onClick={() => setSheet('peek')}>
                    🗺️ {t('needsList.map')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
