import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigationType } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useDialog } from '../context/DialogContext'
import { getCurrentPosition, haversineKm, isInAlgeria } from '../utils'
import { addBaseLayer } from '../mapBase'
import { IconLocate, IconPlus } from '../icons'
import '../explore.css'

// The "explore" map shared by every map page (Signalements, SOS/Besoins,
// collection points in Algeria and abroad, deliveries), Airbnb style: the
// map fills the screen, and the items *visible in it* are listed --
//   - phone: a bottom sheet (half height at first; drag its handle or the
//     list itself to full / half / peek); tapping a pin puts the sheet
//     away and shows that item's card in a carousel (slide for its
//     neighbours; tapping the map puts the card away);
//   - wide screen: the list beside the map, hovering a card lights up its
//     pin.
// Panning/zooming or changing a filter refreshes the list and the "N ici"
// count at once; nearby pins merge into numbered clusters (tap = zoom in).
// Items with no exact position are grouped in one bubble per `group` (a
// wilaya, a country...): tapping it lists that group. "Retour" from an
// item's page brings the same map view back.
//
// Each page hands over its items, already filtered, normalized as
//   { id, lat, lng, exact, group?, raw }   (lat/lng = where to draw it)
// plus how to draw them: pin(item) -> { html, color, blink }, card(item) ->
// { to, title, subtitle, text, image, video, iconHtml, badges: [{ text,
// tone }], meta: [text] } and bubble(items) -> { html }. `offMap` items
// (no position at all) get a chip that lists them.

const CLUSTER_PX = 54 // pins closer than this on screen merge...
const CLUSTER_UNTIL_ZOOM = 15 // ...up to this zoom; closer in, every item has its own pin
const WIDE_QUERY = '(min-width: 900px)'
const CAROUSEL_MAX = 40

function pinIcon(pin, lit) {
  const size = lit ? 48 : 34
  const cls = ['xp-pin', pin.blink ? 'is-blink' : '', lit ? 'is-selected' : ''].filter(Boolean).join(' ')
  return L.divIcon({
    className: 'xp-marker-icon',
    html: `<span class="${cls}" style="--pin:${pin.color || '#1f5fbf'}">${pin.html}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function clusterIcon(count, lit, color) {
  const size = count < 10 ? 44 : count < 50 ? 52 : 60
  return L.divIcon({
    className: 'xp-marker-icon',
    html: `<span class="xp-cluster${lit ? ' is-selected' : ''}" style="width:${size}px;height:${size}px;--pin:${color}">${count}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// Greedy on-screen clustering, recomputed on every zoom: an item joins
// the first group whose pin is within CLUSTER_PX, else starts its own.
function clusterItems(map, items) {
  const zoom = map.getZoom()
  const groups = []
  items.forEach((item) => {
    const ll = L.latLng(item.lat, item.lng)
    const pt = map.project(ll, zoom)
    const group = zoom <= CLUSTER_UNTIL_ZOOM && groups.find((g) => g.pt.distanceTo(pt) < CLUSTER_PX)
    if (group) {
      group.items.push(item)
      group.bounds.extend(ll)
    } else groups.push({ pt, ll, items: [item], bounds: L.latLngBounds(ll, ll) })
  })
  return groups
}

// Zoomed all the way in, items on the very same spot are nudged apart on
// screen so each pin stays tappable.
const SPREAD_MIN_PX = 58
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

function Thumb({ c }) {
  return (
    <span className="sx-thumb">
      {c.image ? (
        <img src={c.image} alt="" loading="lazy" />
      ) : c.video ? (
        <>
          <video src={`${c.video}#t=0.5`} muted playsInline preload="metadata" />
          <span className="sx-thumb-play" aria-hidden="true">▶</span>
        </>
      ) : (
        <span className="sx-thumb-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: c.iconHtml || '' }} />
      )}
      {(c.image || c.video) && c.iconHtml && <span className="sx-thumb-badge" aria-hidden="true" dangerouslySetInnerHTML={{ __html: c.iconHtml }} />}
    </span>
  )
}

function ItemCard({ c, id, distance, selected, compact, onHover }) {
  return (
    <Link
      to={c.to}
      data-id={id}
      className={`sx-card${selected ? ' is-selected' : ''}${compact ? ' is-compact' : ''}`}
      onMouseEnter={onHover ? () => onHover(id) : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      <Thumb c={c} />
      <span className="sx-card-info">
        <b>{c.title}</b>
        {c.subtitle && <small>{c.subtitle}</small>}
        {!compact && c.text && <span className="sx-card-text">{c.text}</span>}
        <span className="sx-card-meta">
          {(c.meta || []).map((m, i) => (
            <span key={i}>{m}</span>
          ))}
          {distance != null && <span>📍 {formatKm(distance)}</span>}
          {(c.badges || []).map((b, i) => (
            <span key={`b${i}`} className={`sx-badge is-${b.tone || 'blue'}`}>
              {b.text}
            </span>
          ))}
        </span>
      </span>
    </Link>
  )
}

export default function ExploreMap({
  items,
  loading = false,
  error = '',
  pin,
  card,
  bubble,
  clusterColor = '#1f5fbf',
  countLabel, // (n) => "12 besoins ici"
  emptyLabel,
  addButton, // { to, label }
  filterPanel, // (close) => JSX
  filterCount = 0,
  chips = [], // [{ key, label, clear }]
  fitKey = '',
  fit, // (map, points, options) => void, when the filters change
  emptyView = [[34.5, 3], 5],
  focusId = null,
  myPos: myPosProp = null,
  offMap = null, // { items, label }
  onSelect, // (item, overlay, map) -- e.g. draw a route on `overlay`
  storageKey,
  minZoom,
  onMapReady, // (map) -- e.g. to fly to a searched place
  aroundMeKm = 0, // on arrival: frame this radius around the visitor (in Algeria), nothing hidden
}) {
  // Coming back (browser/app "Retour") restores the last view; any other
  // arrival (bottom-nav tab, link) starts afresh.
  const navigationType = useNavigationType()
  const { t } = useTranslation()
  const { showAlert } = useDialog()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [sheet, setSheet] = useState(focusId ? 'card' : 'half')
  const sheetModeRef = useRef(sheet)
  useEffect(() => {
    sheetModeRef.current = sheet
  }, [sheet])
  const [groupOnly, setGroupOnly] = useState(null) // { key, label } | { offMap: true }
  const [viewIds, setViewIds] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [hoveredId, setHoveredId] = useState(null)
  const [myPos, setMyPos] = useState(myPosProp)
  useEffect(() => {
    if (myPosProp) setMyPos(myPosProp)
  }, [myPosProp])
  const [wide, setWide] = useState(() => window.matchMedia?.(WIDE_QUERY).matches ?? false)
  const [height, setHeight] = useState(560)

  useEffect(() => {
    const mq = window.matchMedia?.(WIDE_QUERY)
    if (!mq) return
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // A new filter (fitKey) drops the "one group only" list.
  useEffect(() => {
    setGroupOnly(null)
  }, [fitKey])

  const byId = useMemo(() => new Map(items.map((x) => [x.id, x])), [items])
  const located = useMemo(() => items.filter((x) => x.exact !== false || !x.group), [items])
  const grouped = useMemo(() => items.filter((x) => x.exact === false && x.group), [items])

  const shown = useMemo(() => {
    if (groupOnly?.offMap) return offMap?.items || []
    if (groupOnly) return grouped.filter((x) => x.group === groupOnly.key)
    return viewIds.map((id) => byId.get(id)).filter(Boolean)
  }, [groupOnly, offMap, grouped, viewIds, byId])
  const cardsById = useMemo(() => {
    const m = new Map()
    shown.forEach((x) => m.set(x.id, card(x)))
    return m
  }, [shown, card])
  const distanceOf = (x) => (myPos && x.lat != null ? haversineKm(myPos, [x.lat, x.lng]) : null)

  // --- layout: fills the screen down to the bottom nav, full-bleed ---
  const rootRef = useRef(null)
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
  const overlayRef = useRef(null)
  const meRef = useRef(null)
  const groupsRef = useRef([])
  const bubblesRef = useRef([])
  // Pins, clusters and bubbles landing on (almost) the same spot -- e.g. a
  // wilaya's "approximate position" bubble over the pins around its
  // centre -- are nudged apart on screen, at every zoom.
  const spreadAll = (map) => spreadMarkers([...groupsRef.current.map((g) => g.marker), ...bubblesRef.current], map)
  const fittedRef = useRef('')
  const quietMoveRef = useRef(false) // a pan we made for the carousel: keep its order
  const freshViewRef = useRef(false) // the user moved the map: restart the carousel
  const coverRef = useRef(0) // px of map hidden under the phone's list sheet
  const carouselRef = useRef(null)
  const listRef = useRef(null)
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const fitKeyRef = useRef(fitKey)
  useEffect(() => {
    fitKeyRef.current = fitKey
  }, [fitKey])
  const [zoomTick, setZoomTick] = useState(0)

  // `fresh`: the user moved the map (the carousel starts over); a data
  // refresh or the sheet moving keeps the current card.
  const refreshView = useCallback((fresh = true) => {
    const map = mapRef.current
    if (!map) return
    // Only the part of the map not hidden under the phone's list sheet.
    const size = map.getSize()
    const visibleH = Math.max(80, size.y - coverRef.current)
    const bounds = L.latLngBounds(map.containerPointToLatLng([0, 0]), map.containerPointToLatLng([size.x, visibleH]))
    const center = map.containerPointToLatLng([size.x / 2, visibleH / 2])
    const inView = itemsRef.current
      .filter((x) => x.lat != null && bounds.contains([x.lat, x.lng]))
      .map((x) => [x, center.distanceTo([x.lat, x.lng]) + (x.exact === false ? 1e7 : 0)])
      .sort((a, b) => a[1] - b[1])
      .map(([x]) => x.id)
    if (fresh) freshViewRef.current = true
    setViewIds(inView)
  }, [])

  useEffect(() => {
    const map = L.map(mapEl.current, { attributionControl: false, zoomControl: false, center: emptyView[0], zoom: emptyView[1], minZoom })
    addBaseLayer(map)
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    overlayRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    onMapReady?.(map)
    map.on('zoomend', () => setZoomTick((n) => n + 1))
    // A tap on the map itself (not a pin) puts the card away.
    map.on('click', () => {
      if (sheetModeRef.current === 'card') {
        setSheet('peek')
        setSelectedId(null)
        overlayRef.current?.clearLayers()
      }
    })
    map.on('moveend', () => {
      try {
        const c = map.getCenter()
        // Not before the first fit: the initial resize would save the
        // default view over the one to restore.
        if (fittedRef.current && storageKey) sessionStorage.setItem(storageKey, JSON.stringify({ f: fitKeyRef.current, c: [c.lat, c.lng], z: map.getZoom() }))
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- created once
  }, [refreshView])

  useEffect(() => {
    mapRef.current?.invalidateSize()
  }, [height, wide])

  // Highlight the selected/hovered item's pin (or the cluster holding it)
  // without rebuilding every marker.
  const lit = hoveredId || selectedId
  const litRef = useRef(lit)
  useEffect(() => {
    litRef.current = lit
  }, [lit])
  const pinRef = useRef(pin)
  useEffect(() => {
    pinRef.current = pin
  }, [pin])
  const lightMarkers = useCallback(() => {
    const map = mapRef.current
    let moved = false
    groupsRef.current.forEach((g) => {
      const on = g.items.some((x) => x.id === litRef.current)
      if (on === g.lit) return
      g.lit = on
      g.marker.setIcon(g.single ? pinIcon(pinRef.current(g.items[0]), on) : clusterIcon(g.items.length, on, clusterColor))
      g.marker.setZIndexOffset(on ? 1500 : 0)
      moved = true
    })
    if (moved && map) spreadMarkers([...groupsRef.current.map((x) => x.marker), ...bubblesRef.current], map)
  }, [clusterColor])
  useEffect(() => lightMarkers(), [lit, lightMarkers])

  // Markers: rebuilt on data or zoom change (clusters depend on the zoom).
  const selectRef = useRef(() => {})
  const bubbleRef = useRef(bubble)
  useEffect(() => {
    bubbleRef.current = bubble
  }, [bubble])
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const groups = []
    clusterItems(
      map,
      located.filter((x) => x.lat != null)
    ).forEach((g) => {
      const single = g.items.length === 1
      const marker = L.marker(g.ll, {
        icon: single ? pinIcon(pinRef.current(g.items[0]), false) : clusterIcon(g.items.length, false, clusterColor),
        title: single ? cardsTitle(g.items[0]) : String(g.items.length),
      })
        .on('click', () => {
          if (single) selectRef.current(g.items[0].id, 'map')
          else map.fitBounds(g.bounds.pad(0.4), { maxZoom: CLUSTER_UNTIL_ZOOM + 2 })
        })
        .addTo(layer)
      groups.push({ marker, items: g.items, single, lit: false })
    })
    // No exact position: one bubble per group (wilaya, country...), on its
    // shared spot; tapping it lists that group's items.
    const byGroup = new Map()
    const bubbleMarkers = []
    grouped.forEach((x) => byGroup.set(x.group, [...(byGroup.get(x.group) || []), x]))
    byGroup.forEach((members, key) => {
      const b = bubbleRef.current ? bubbleRef.current(members) : { html: `<span class="xp-bubble">${members.length}</span>`, label: '' }
      const bubbleMarker = L.marker([members[0].lat, members[0].lng], {
        icon: L.divIcon({ className: 'xp-marker-icon', html: b.html, iconSize: [64, 64], iconAnchor: [32, 32] }),
        zIndexOffset: 2000,
        title: b.label || '',
      })
        .on('click', () => {
          setGroupOnly({ key, label: b.label || '' })
          setSelectedId(members[0].id)
          if (!window.matchMedia?.(WIDE_QUERY).matches) setSheet('half')
        })
        .addTo(layer)
      bubbleMarkers.push(bubbleMarker)
    })
    groupsRef.current = groups
    bubblesRef.current = bubbleMarkers
    spreadAll(map)
    lightMarkers()
    refreshView(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pin/bubble via refs
  }, [located, grouped, zoomTick, refreshView, lightMarkers, clusterColor])

  function cardsTitle(x) {
    try {
      return card(x).title
    } catch {
      return ''
    }
  }

  // Me (after "center on me" / a position handed over by the page).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !myPos) return
    meRef.current?.remove()
    meRef.current = L.circleMarker(myPos, { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1, interactive: false }).addTo(map)
  }, [myPos])

  // Phone list sheet: its snap heights, and how much map it hides.
  const snaps = { full: 0, half: Math.round(height * 0.5), peek: height - 74 }
  const sheetTop = sheet === 'card' ? height : snaps[sheet]
  const cover = wide || sheet === 'card' || sheet === 'full' ? 0 : height - sheetTop
  // Bottom of the map still in view: where the map credit sits.
  const mapBottom = wide ? 0 : sheet === 'card' ? 144 : sheet === 'full' ? 0 : height - sheetTop
  useEffect(() => {
    if (coverRef.current === cover) return
    coverRef.current = cover
    refreshView(false)
  }, [cover, refreshView])

  // Refit when the filters (or the focused item) change -- not on every
  // selection, the view mustn't jump under the finger.
  const focused = focusId != null ? byId.get(focusId) : null
  useEffect(() => {
    const map = mapRef.current
    if (!map || loading) return
    const key = `${fitKey}|${focused?.id || ''}`
    if (fittedRef.current === key) return
    const firstFit = !fittedRef.current
    fittedRef.current = key
    // Back from an item's page ("Retour"): same place as before.
    if (firstFit && !focusId && storageKey && navigationType === 'POP') {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null')
        if (saved?.f === fitKey && saved.c) {
          map.setView(saved.c, saved.z)
          return
        }
      } catch {
        /* nothing saved */
      }
    }
    // Room for the floating bar / buttons, and the list sheet below.
    const pad = { paddingTopLeft: [30, 110], paddingBottomRight: [60, coverRef.current + 30] }
    const points = items.filter((x) => x.lat != null).map((x) => [x.lat, x.lng])
    if (focused?.lat != null) {
      map.setView([focused.lat, focused.lng], focused.exact === false ? 11 : 16)
      setSelectedId(focused.id)
    } else if (fit) fit(map, points, pad)
    else if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 15, ...pad })
    else map.setView(emptyView[0], emptyView[1])
    // Arriving on the map: then frame `aroundMeKm` around the visitor, once
    // their position is known -- only in Algeria (abroad, or no position:
    // the view above, every item). Nothing is hidden: zoom out to see more.
    if (firstFit && aroundMeKm && !focusId) {
      getCurrentPosition({ maximumAge: 300000, timeout: 6000, enableHighAccuracy: false }).then((pos) => {
        if (!pos || !mapRef.current || fittedRef.current !== key) return
        setMyPos(pos)
        if (!isInAlgeria(pos[0], pos[1])) return
        const m = mapRef.current
        // The zoom at which the visible part of the map (above the list
        // sheet) stays within the radius, the visitor in its middle.
        const size = m.getSize()
        const visible = L.point(size.x, Math.max(120, size.y - coverRef.current))
        const zoom = Math.min(15, Math.max(5, Math.round(m.getBoundsZoom(L.latLng(pos[0], pos[1]).toBounds(aroundMeKm * 2000), true) - Math.log2(size.y / visible.y))))
        // After the first framing's own zoom animation, or it would undo this.
        const go = () => {
          m.setView(pos, zoom, { animate: false })
          m.panBy([0, coverRef.current / 2], { animate: false })
        }
        // (Leaflet starts that animation a frame later, so give it a moment.)
        setTimeout(() => {
          if (m._animatingZoom) m.once('zoomend', go)
          else go()
        }, 400)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, loading, fitKey, focused, focusId])

  // --- selection: pin <-> carousel card / list card ---
  const scrollCardIntoView = (id) => {
    const box = wide ? listRef.current : carouselRef.current
    const el = box?.querySelector(`[data-id="${id}"]`)
    if (!box || !el) return
    if (wide) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' })
    else box.scrollTo({ left: el.offsetLeft - (box.clientWidth - el.clientWidth) / 2, behavior: 'smooth' })
  }
  const runOnSelect = (id) => {
    const overlay = overlayRef.current
    overlay?.clearLayers()
    const x = byId.get(id)
    if (x && onSelect && overlay && mapRef.current) onSelect(x, overlay, mapRef.current)
  }
  const select = (id, source) => {
    setSelectedId(id)
    if (source === 'map') {
      if (!wide) setSheet('card')
      if (groupOnly && !shown.some((x) => x.id === id)) setGroupOnly(null)
      runOnSelect(id)
      requestAnimationFrame(() => requestAnimationFrame(() => scrollCardIntoView(id)))
      return
    }
    // From the carousel: bring its pin into view if it's hidden behind the
    // top bar / the carousel, without re-sorting the carousel.
    runOnSelect(id)
    const map = mapRef.current
    const x = byId.get(id)
    if (!map || !x || x.lat == null) return
    const pt = map.latLngToContainerPoint([x.lat, x.lng])
    const size = map.getSize()
    const bottomReserve = wide ? 40 : 190
    if (pt.x < 40 || pt.x > size.x - 40 || pt.y < 110 || pt.y > size.y - bottomReserve) {
      quietMoveRef.current = true
      map.panInside([x.lat, x.lng], { paddingTopLeft: [40, 110], paddingBottomRight: [40, bottomReserve] })
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
      box.querySelectorAll('[data-id]').forEach((el) => {
        const r = el.getBoundingClientRect()
        const d = Math.abs(r.left + r.width / 2 - mid)
        if (d < bestD) {
          best = el.dataset.id
          bestD = d
        }
      })
      const id = best != null ? byIdKey(best) : null
      if (id != null && id !== selectedId) select(id, 'carousel')
    }, 120)
  }
  // data-id is a string; ids may be numbers or strings.
  const byIdKey = (raw) => {
    if (byId.has(raw)) return raw
    const n = Number(raw)
    return byId.has(n) ? n : null
  }

  // A fresh set of cards (the map was moved/zoomed, a filter changed):
  // start again from the first card -- the item nearest the centre --
  // unless the map moved only to show the selected card's pin.
  const shownKey = shown.map((x) => x.id).join(',')
  const firstShown = shown[0]?.id
  const selectedShown = shown.some((x) => x.id === selectedId)
  useEffect(() => {
    if (wide || sheet !== 'card' || firstShown == null) return
    if (!freshViewRef.current && selectedShown) return
    freshViewRef.current = false
    if (focusId != null && selectedShown) {
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
    setGroupOnly(null)
    const points = items.filter((x) => x.lat != null).map((x) => [x.lat, x.lng])
    if (points.length) mapRef.current?.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 15 })
  }

  const allChips = [
    ...chips,
    groupOnly && { key: '_group', label: groupOnly.offMap ? offMap?.label : groupOnly.label, clear: () => setGroupOnly(null) },
    !groupOnly &&
      offMap?.items?.length > 0 && {
        key: '_offmap',
        label: `${offMap.label} (${offMap.items.length})`,
        open: () => {
          setGroupOnly({ offMap: true })
          if (!wide) setSheet('half')
        },
      },
  ].filter(Boolean)

  const headLabel = loading ? t('common.loading') : groupOnly?.offMap ? `${offMap?.label} (${shown.length})` : countLabel(shown.length)
  const empty = !loading && !shown.length && (
    <div className="sx-empty">
      <span>{items.length ? t('explore.noneInArea') : emptyLabel}</span>
      {!!items.length && (
        <button type="button" className="sx-pill is-dark" onClick={showAll}>
          {t('explore.showAll')}
        </button>
      )}
    </div>
  )
  const listHead = (
    <div className="sx-list-head">
      <h2>{headLabel}</h2>
      {myPos && <small>{t('explore.sortedByDistance')}</small>}
    </div>
  )
  const listBody = (
    <>
      {empty}
      <div className="sx-list-grid">
        {shown.map((x) => (
          <ItemCard key={x.id} id={x.id} c={cardsById.get(x.id)} distance={distanceOf(x)} selected={x.id === lit} onHover={wide ? setHoveredId : undefined} compact={!wide} />
        ))}
      </div>
    </>
  )

  // --- phone bottom sheet: dragged by its handle, or by the list itself
  // (like Airbnb): at half height, sliding the list up opens it full and
  // down folds it; at full height, scrolled back to the top, sliding down
  // brings the map back. ---
  const sheetRef = useRef(null)
  const bodyRef = useRef(null)
  const dragRef = useRef(null)
  const moveSheet = (startTop, dy) => {
    const el = sheetRef.current
    if (!el) return
    el.style.transition = 'none'
    el.style.top = `${Math.min(snaps.peek, Math.max(snaps.full, startTop + dy))}px`
  }
  // Where the sheet would coast to with the finger's speed, then the
  // nearest snap height to that.
  const settleSheet = (startTop, dy, ms) => {
    const el = sheetRef.current
    if (!el) return
    const speed = dy / Math.max(1, ms) // px/ms, + = down
    const projected = startTop + dy + speed * 180
    const target = ['full', 'half', 'peek'].reduce((a, b) => (Math.abs(snaps[b] - projected) < Math.abs(snaps[a] - projected) ? b : a))
    el.style.transition = ''
    el.style.top = `${snaps[target]}px`
    setSheet(target)
  }
  const sheetFns = useRef({})
  useEffect(() => {
    sheetFns.current = { moveSheet, settleSheet, top: sheetTop, mode: sheet }
  })
  const onSheetDown = (e) => {
    dragRef.current = { y: e.clientY, top: sheetTop, t: performance.now(), moved: false }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onSheetMove = (e) => {
    const d = dragRef.current
    if (!d) return
    const dy = e.clientY - d.y
    if (Math.abs(dy) > 4) d.moved = true
    if (d.moved) moveSheet(d.top, dy)
  }
  const onSheetUp = (e) => {
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (d.moved) return settleSheet(d.top, e.clientY - d.y, performance.now() - d.t)
    // A tap on the handle: peek -> half -> full -> half.
    const target = sheet === 'peek' ? 'half' : sheet === 'half' ? 'full' : 'half'
    const el = sheetRef.current
    if (el) el.style.top = `${snaps[target]}px`
    setSheet(target)
  }
  // The list's own touches: a native, non-passive listener, so a slide
  // that moves the sheet can stop the list from scrolling at the same time.
  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    let g = null
    const start = (e) => {
      const tt = e.touches[0]
      g = { y: tt.clientY, x: tt.clientX, t: performance.now(), top: sheetFns.current.top, mode: sheetFns.current.mode, dragging: false, decided: false }
    }
    const move = (e) => {
      if (!g) return
      const tt = e.touches[0]
      const dy = tt.clientY - g.y
      if (!g.decided) {
        if (Math.abs(dy) < 6 && Math.abs(tt.clientX - g.x) < 6) return
        g.decided = true
        const atTop = body.scrollTop <= 0
        g.dragging = Math.abs(dy) > Math.abs(tt.clientX - g.x) && ((g.mode === 'half' && (dy < 0 || atTop)) || (g.mode === 'full' && dy > 0 && atTop))
        if (g.dragging) {
          g.y = tt.clientY
          g.t = performance.now()
        }
      }
      if (!g.dragging) return
      e.preventDefault()
      sheetFns.current.moveSheet(g.top, tt.clientY - g.y)
    }
    const end = (e) => {
      if (g?.dragging) {
        const tt = e.changedTouches[0]
        sheetFns.current.settleSheet(g.top, tt.clientY - g.y, performance.now() - g.t)
      }
      g = null
    }
    body.addEventListener('touchstart', start, { passive: true })
    body.addEventListener('touchmove', move, { passive: false })
    body.addEventListener('touchend', end)
    body.addEventListener('touchcancel', end)
    return () => {
      body.removeEventListener('touchstart', start)
      body.removeEventListener('touchmove', move)
      body.removeEventListener('touchend', end)
      body.removeEventListener('touchcancel', end)
    }
  }, [wide])

  return (
    <section className="signalements-page is-explore">
      <div ref={rootRef} className={`sx${wide ? ' is-wide' : ''}`} style={{ height, '--sx-map-bottom': `${mapBottom}px` }}>
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
              {filterPanel && (
                <button type="button" className={`sx-pill${filtersOpen ? ' is-dark' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((v) => !v)}>
                  ☰ {t('common.filters')}
                  {filterCount > 0 && <b className="sx-pill-count">{filterCount}</b>}
                </button>
              )}
              <span className="sx-pill is-count" role="status">{loading ? '…' : t('explore.inAreaShort', { count: shown.length })}</span>
              {addButton && (
                <Link to={addButton.to} className="sx-pill is-primary" aria-label={addButton.label}>
                  <IconPlus width={15} height={15} strokeWidth={2.8} /> {addButton.label}
                </Link>
              )}
            </div>
            {!!allChips.length && (
              <div className="sx-chips">
                {allChips.map((c) =>
                  c.open ? (
                    <button key={c.key} type="button" className="sx-chip is-light" onClick={c.open}>
                      {c.label}
                    </button>
                  ) : (
                    <span key={c.key} className="sx-chip">
                      {c.label}
                      <button type="button" onClick={c.clear} aria-label={t('common.close')}>×</button>
                    </span>
                  )
                )}
              </div>
            )}
            {filtersOpen && filterPanel && (
              <div className="sx-filters">
                {filterPanel(() => setFiltersOpen(false))}
                <button type="button" className="sx-pill is-dark sx-filters-done" onClick={() => setFiltersOpen(false)}>
                  {t('explore.showResults', { count: items.length })}
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
                    ☰ {t('explore.listCount', { count: shown.length })}
                  </button>
                  <div className="sx-carousel" ref={carouselRef} onScroll={onCarouselScroll}>
                    {empty}
                    {shown.slice(0, CAROUSEL_MAX).map((x) => (
                      <ItemCard key={x.id} id={x.id} c={cardsById.get(x.id)} distance={distanceOf(x)} selected={x.id === selectedId} />
                    ))}
                  </div>
                </>
              )}
              <div ref={sheetRef} className={`sx-sheet is-${sheet}`} style={{ top: sheetTop }}>
                <div className="sx-sheet-grab" onPointerDown={onSheetDown} onPointerMove={onSheetMove} onPointerUp={onSheetUp} onPointerCancel={onSheetUp}>
                  <span className="sx-sheet-handle" aria-hidden="true" />
                  {listHead}
                </div>
                <div className="sx-sheet-body" ref={bodyRef}>
                  {listBody}
                </div>
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
