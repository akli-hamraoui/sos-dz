// Shared pin/popup builders for the combined "Je veux aider" map
// (Help.jsx), which needs both Need (SOS) and CollectionPoint markers on
// one map -- same visual language (icon shapes, urgency colors) already
// used separately by NeedsList.jsx and CollectionPoints.jsx, factored out
// here rather than a third copy-pasted inline SVG string.

export const NEED_SOS_ICON = '<img src="/icons/need-marker-sos.png" width="18" height="18" alt="" style="filter:invert(1)" />'

export const CP_BOX_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z"/><path d="M3.5 7.5 12 12l8.5-4.5"/><path d="M12 12v9"/></svg>'

export function needIcon(L, urgencyColor, urgency) {
  return L.divIcon({
    className: 'need-marker-icon',
    html: `<span class="need-marker-pin" style="background:${urgencyColor(urgency)}">${NEED_SOS_ICON}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  })
}

const TRUCK_SVG =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.9" ' +
  'stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5h11v8h-11Z"/><path d="M13.5 11h4l3 2.8v1.7h-7Z"/>' +
  '<circle cx="7" cy="18" r="1.7"/><circle cx="17" cy="18" r="1.7"/><path d="M2.5 16h2.8M15.5 16h.2M18.7 16H21"/></svg>'

export const TRUCK_GREEN = '#2f6b52'

// Same truck-on-white-circle marker used on the Transporteurs map
// (Deliveries.jsx) and the per-need live map (NeedDetail.jsx) -- factored
// out here for PickupDetail's single-position map so a third inline copy
// of this SVG isn't needed. isLive=false gets the muted/dashed
// pickup-marker-pin-departure styling (see index.css) so a declared
// starting point is never mistaken for an actual live ping.
export function truckIcon(L, isLive) {
  return L.divIcon({
    className: `pickup-marker-icon${isLive ? '' : ' pickup-marker-departure'}`,
    html: `<span class="pickup-marker-pin${isLive ? '' : ' pickup-marker-pin-departure'}">${TRUCK_SVG.replace('{color}', TRUCK_GREEN)}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  })
}

export function collectionPointIcon(L) {
  return L.divIcon({
    className: 'cp-marker-icon',
    html: `<span class="cp-marker-pin">${CP_BOX_SVG}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  })
}

// A CollectionPoint's own country_code is blank for a national (Algeria)
// point (see CollectionPoint.country_code, backend) rather than "DZ" --
// default to it here so every collection point popup gets a flag, not
// just international ones.
export function countryFlagEmoji(countryCode) {
  const code = (countryCode || 'DZ').toUpperCase()
  if (!/^[A-Z]{2}$/.test(code)) return ''
  return String.fromCodePoint(...[...code].map((c) => 127397 + c.charCodeAt(0)))
}

// A precise one-decimal figure (e.g. "30.7") reads fine for a nearby point,
// but the international map's points can be genuinely anywhere on Earth --
// a false precision like "20300.0" for an antipodal point is both harder to
// read and not meaningfully more accurate than a round "~20k" would be at
// that distance. Only the popup's own distance line (see CollectionPoints.jsx/
// InternationalCollectionPoints.jsx) uses this; drawRouteToPoint's own
// resolved-route distance stays as-is (always well under 1000km, since it
// never even runs past the 100km cutoff).
export function formatApproxKm(km) {
  if (km >= 1000) return `~${Math.round(km / 1000)}k`
  return km.toFixed(1)
}

// "View flyer" shortcut icon inside a marker's own popup -- a plain image
// glyph (not a camera) since what's behind it is a flyer/damage/delivery
// photo already taken, not something the popup itself photographs. Sized
// to sit inline with the popup's own text instead of towering over it.
const FLYER_ICON_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="3" y="3" width="18" height="18" rx="2.5"/>' +
  '<circle cx="9" cy="9" r="1.8"/><path d="m21 15-4.5-4.5a2 2 0 0 0-2.8 0L6 18"/></svg>'

// Builds the "view flyer" popup button (or '' when the pin has no photo).
// Deliberately laid out separately from the popup's own "Ouvrir" link (see
// each map page's popupopen handler + the .popup-actions row in index.css)
// rather than stacked directly under it, so the two don't read as one
// cramped block.
export function flyerPopupButtonHtml(t, photoUrl) {
  if (!photoUrl) return ''
  return `<button type="button" class="popup-photo-btn" data-photo-url="${photoUrl}">${FLYER_ICON_SVG} ${t('common.viewFlyer')}</button>`
}

// Lets a two-finger pinch over an open popup zoom the popup's own text/photo
// instead of the map underneath it -- reported live: the popup's font is
// small and a reflex pinch over it (the same gesture used everywhere else on
// the page to zoom the map) was instead panning/zooming the whole map out
// from under the point the visitor was trying to read. Only a *two*-finger
// touch on the popup itself is intercepted (stopPropagation keeps it from
// ever reaching Leaflet's own TouchZoom handler on the map container, which
// listens on that same bubbling touchstart/touchmove); a single finger --
// tapping the flyer button, a link, the popup's own close "x", or a one-
// finger drag -- is left completely alone. Call once per popup, from the
// map's own 'popupopen' handler (see each map page).
export function attachPopupPinchZoom(popupEl) {
  const content = popupEl?.querySelector('.leaflet-popup-content')
  if (!content) return
  // Every open (even a repeat open of the same marker) starts back at the
  // popup's natural size -- a pinch left over from a previous look at this
  // same point shouldn't still be applied the next time it's opened.
  content.style.transformOrigin = 'top left'
  content.style.transform = 'scale(1)'
  content._pinchScale = 1
  // Each marker keeps the same popup DOM element across repeated opens, and
  // 'popupopen' fires again on every one of those -- guard against wiring
  // the same element's touch listeners more than once (they'd otherwise
  // pile up, each firing the same pinch on every later touch).
  if (content.dataset.pinchZoomWired) return
  content.dataset.pinchZoomWired = '1'
  let startDist = 0
  let startScale = 1

  const touchDist = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)

  const onTouchStart = (e) => {
    if (e.touches.length !== 2) return
    e.preventDefault()
    e.stopPropagation()
    startDist = touchDist(e.touches)
    startScale = content._pinchScale
  }
  const onTouchMove = (e) => {
    if (e.touches.length !== 2 || !startDist) return
    e.preventDefault()
    e.stopPropagation()
    // Clamped 1x-3x -- shrinking below the popup's own natural size would
    // make it harder to read, the opposite of the point of this gesture.
    content._pinchScale = Math.min(3, Math.max(1, startScale * (touchDist(e.touches) / startDist)))
    content.style.transform = `scale(${content._pinchScale})`
  }
  const onTouchEnd = (e) => {
    if (e.touches.length >= 2) return
    startDist = 0
  }
  content.addEventListener('touchstart', onTouchStart, { passive: false })
  content.addEventListener('touchmove', onTouchMove, { passive: false })
  content.addEventListener('touchend', onTouchEnd, { passive: false })
  content.addEventListener('touchcancel', onTouchEnd, { passive: false })
}

// Lets a two-finger pinch zoom the map immediately, even before the usual
// single-finger "tap to activate" step (see each map page's own mapActive) --
// reported live: pinching on the map zoomed the whole page instead of the
// map, since the map starts "asleep" behind a full-cover overlay div (a
// plain sibling of Leaflet's own container, not a descendant of it) that
// swallows every touch so a one-finger drag reads as page-scroll rather than
// a map pan. A one-finger gesture genuinely needs that tap-first step (it's
// ambiguous with scrolling); a two-finger pinch never is, so there's no
// reason to gate it the same way -- outside the overlay/map entirely,
// nothing here runs and the browser's own native pinch-zooms the page,
// exactly as it already does today.
// Handled by hand (computing zoom from the pinch distance and calling
// map.setZoomAround directly) rather than just enabling Leaflet's own
// TouchZoom, because a touch starting on the overlay never bubbles to
// Leaflet's container-scoped listener in the first place -- it's a sibling
// element, not an ancestor. Once the map is actually awake (mapActive, the
// overlay unmounted) Leaflet's real TouchZoom (enabled in activateMap)
// already handles every pinch correctly on its own; this only covers the
// asleep-overlay gap. onActivate is called once the pinch ends, so the map
// is left "awake" afterwards (matching having just directly interacted with
// it) the same as a tap would have left it.
export function attachMapPinchZoomOverlay(map, overlayEl, onActivate) {
  if (!map || !overlayEl || overlayEl.dataset.pinchZoomWired) return
  overlayEl.dataset.pinchZoomWired = '1'
  let startDist = 0
  let startZoom = 0
  let center = null

  const touchDist = (touches) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
  const touchMidpoint = (touches) => [(touches[0].clientX + touches[1].clientX) / 2, (touches[0].clientY + touches[1].clientY) / 2]

  const onTouchStart = (e) => {
    if (e.touches.length !== 2) return
    e.preventDefault()
    startDist = touchDist(e.touches)
    startZoom = map.getZoom()
    const [mx, my] = touchMidpoint(e.touches)
    const rect = map.getContainer().getBoundingClientRect()
    center = map.containerPointToLatLng([mx - rect.left, my - rect.top])
  }
  const onTouchMove = (e) => {
    if (e.touches.length !== 2 || !startDist) return
    e.preventDefault()
    map.setZoomAround(center, startZoom + Math.log2(touchDist(e.touches) / startDist), { animate: false })
  }
  const onTouchEnd = (e) => {
    if (e.touches.length >= 2) return
    if (startDist) onActivate?.()
    startDist = 0
  }
  overlayEl.addEventListener('touchstart', onTouchStart, { passive: false })
  overlayEl.addEventListener('touchmove', onTouchMove, { passive: false })
  overlayEl.addEventListener('touchend', onTouchEnd, { passive: false })
  overlayEl.addEventListener('touchcancel', onTouchEnd, { passive: false })
}

export function needPopupHtml(t, p, statusLabel) {
  const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
  const urgencyPrefix = p.urgency !== 'medium' ? `${t(`urgency.${p.urgency}`)} — ` : ''
  return (
    `<strong>${p.title}</strong><br>${urgencyPrefix}${p.wilaya_name}<br>${(p.location_description || '').slice(0, 80)}` +
    `<br>${statusLabel(t, p.overall_status)}${gpsNote}<br><a href="/needs/${p.id}">${t('common.open')}</a>`
  )
}

export function collectionPointPopupHtml(t, p) {
  const gpsNote = p.has_exact_position ? '' : `<br><em>${t('common.noExactGpsPosition')}</em>`
  return (
    `<strong>${p.point_name} ${countryFlagEmoji(p.country_code)}</strong><br>${p.contact_name}${p.organization ? '<br>' + p.organization : ''}` +
    `${p.hours ? '<br>' + p.hours : ''}<br>${p.wilaya_name}${gpsNote}<br><a href="/collection-points/${p.id}">${t('common.open')}</a>`
  )
}
