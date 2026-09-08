// Shared pin/popup builders for the combined "Je veux aider" map
// (Help.jsx), which needs both Need (SOS) and CollectionPoint markers on
// one map -- same visual language (icon shapes, urgency colors) already
// used separately by NeedsList.jsx and CollectionPoints.jsx, factored out
// here rather than a third copy-pasted inline SVG string.

import L from 'leaflet'

export const NEED_SOS_ICON = '<img src="/icons/need-marker-sos.png" width="18" height="18" alt="" style="filter:invert(1)" />'

export const CP_BOX_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2c8f67" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
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
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  })
}

// Give nearby collection-point pins a little breathing room without changing
// their real geographic coordinates. The offsets are applied to the inner
// visual pin, so the marker remains clickable at its original location.
// Recomputed after zoom because pixel distances change with zoom level.
export function spreadCollectionPointMarkers(map, markers, minDistance = 46) {
  if (!map || !Array.isArray(markers)) return

  map._sosdzCollectionMarkers = markers
  if (!map._sosdzCollectionSpreadZoomWired) {
    map._sosdzCollectionSpreadZoomWired = true
    map.on('zoomend', () => {
      spreadCollectionPointMarkers(map, map._sosdzCollectionMarkers || [], minDistance)
    })
  }

  const cpMarkers = markers.filter((marker) => marker?._sosdzCollectionPoint && marker._icon)
  if (!cpMarkers.length) return

  const positions = cpMarkers.map((marker) => map.latLngToContainerPoint(marker.getLatLng()))
  const offsets = cpMarkers.map(() => ({ x: 0, y: 0 }))

  // A few relaxation passes are enough for the small clusters visible on
  // mobile, while keeping the displacement subtle.
  for (let pass = 0; pass < 5; pass += 1) {
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const ax = positions[i].x + offsets[i].x
        const ay = positions[i].y + offsets[i].y
        const bx = positions[j].x + offsets[j].x
        const by = positions[j].y + offsets[j].y
        const dx = bx - ax
        const dy = by - ay
        const distance = Math.hypot(dx, dy)

        if (distance >= minDistance) continue

        const safeDistance = distance || 1
        const push = (minDistance - safeDistance) / 2 + 1
        const ux = dx / safeDistance
        const uy = dy / safeDistance
        offsets[i].x -= ux * push
        offsets[i].y -= uy * push
        offsets[j].x += ux * push
        offsets[j].y += uy * push
      }
    }
  }

  cpMarkers.forEach((marker, index) => {
    const pin = marker._icon?.querySelector('.cp-marker-pin')
    if (!pin) return
    const x = Math.max(-24, Math.min(24, offsets[index].x))
    const y = Math.max(-24, Math.min(24, offsets[index].y))
    pin.style.transform = `translate3d(${x}px, ${y}px, 0)`
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

// Lets a two-finger pinch over an open popup zoom the whole popup box --
// background, text and photo button together, not just the text -- instead
// of the map underneath it. Reported live twice: first that the popup's
// font is small and a reflex pinch over it (the same gesture used
// everywhere else on the page to zoom the map) was instead panning/zooming
// the whole map out from under the point being read; then, once that was
// fixed by scaling the text alone, that the enlarged text was spilling out
// past the edges of an unchanged-size box instead of the box growing along
// with it. Only a *two*-finger
// touch on the popup itself is intercepted (stopPropagation keeps it from
// ever reaching Leaflet's own TouchZoom handler on the map container, which
// listens on that same bubbling touchstart/touchmove); a single finger --
// tapping the flyer button, a link, the popup's own close "x", or a one-
// finger drag -- is left completely alone. Call once per popup, from the
// map's own 'popupopen' handler (see each map page).
// Shared behavior for every Leaflet popup in the application.
// The popup is centered in the visible map viewport when it opens and
// re-centered after map moves while it remains open. This keeps popups
// readable on mobile and prevents a route fitBounds() from stranding an
// already-open popup near the edge of the map.
// Preserves the map's two-finger pinch gesture while the map is still
// covered by the tap-to-activate overlay. This is intentionally separate
// from popup zoom: the popup itself must not have custom +/-/1x controls.
// Activate map interaction only when the user taps the map surface itself.
// Marker, popup and control clicks are intentionally ignored so the first tap
// on a collection point, SOS need or courier opens that point normally instead
// of being consumed by the map's "tap to interact" mode.
export function attachMapTapToActivate(map, onActivate) {
  if (!map || map._sosdzTapActivationWired) return
  map._sosdzTapActivationWired = true

  map.on('click', (event) => {
    const target = event?.originalEvent?.target
    if (target?.closest?.('.leaflet-marker-icon, .leaflet-popup, .leaflet-control, button, a')) return
    onActivate?.()
  })
}

export function attachMapPopupBehavior(map, onPhoto, onActivate) {
  if (!map) return

  let openPopup = null

  // Keep the popup inside the map frame while centering it in the usable
  // viewport. The bottom interaction chip is part of the frame, so reserve
  // only its footprint and never the page/bottom navigation. The popup pane
  // itself is layered above the map controls by CSS, so the controls cannot
  // cover the popup.
  const centerPopupOnScreen = (popup) => {
    const center = () => {
      if (!map._container?.isConnected || !popup?.isOpen?.()) return

      const mapEl = map.getContainer()
      const popupEl = popup.getElement()
      if (!mapEl || !popupEl) return

      const mapRect = mapEl.getBoundingClientRect()
      const popupRect = popupEl.getBoundingClientRect()
      if (!mapRect.width || !mapRect.height || !popupRect.width || !popupRect.height) return

      const frame = mapEl.closest('.map-frame')
      const topControls = frame?.querySelectorAll('.map-activate-hint, .map-deactivate-btn, .expand-btn, .locate-btn') || []
      let topReserve = 0
      topControls.forEach((control) => {
        const rect = control.getBoundingClientRect()
        const overlapsMap = rect.bottom > mapRect.top && rect.top < mapRect.bottom
        if (overlapsMap) {
          topReserve = Math.max(topReserve, Math.min(76, rect.bottom - mapRect.top + 8))
        }
      })

      const padding = Math.min(10, Math.max(6, mapRect.width * 0.02))
      const targetCenterX = mapRect.left + mapRect.width / 2
      const targetCenterY = mapRect.top + topReserve + (mapRect.height - topReserve) / 2

      // Clamp the desired popup center so the whole card remains inside the
      // map frame. This also handles narrow phones/tablets without pushing
      // the map unnecessarily far away from the selected point.
      const minCenterX = mapRect.left + padding + popupRect.width / 2
      const maxCenterX = mapRect.right - padding - popupRect.width / 2
      const minCenterY = mapRect.top + padding + topReserve + popupRect.height / 2
      const maxCenterY = mapRect.bottom - padding - popupRect.height / 2
      const desiredCenterX = Math.min(Math.max(targetCenterX, minCenterX), maxCenterX)
      const desiredCenterY = Math.min(Math.max(targetCenterY, minCenterY), maxCenterY)

      const popupCenterX = popupRect.left + popupRect.width / 2
      const popupCenterY = popupRect.top + popupRect.height / 2
      const dx = popupCenterX - desiredCenterX
      const dy = popupCenterY - desiredCenterY

      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        map.panBy([dx, dy], { animate: false })
      }
    }

    // The popup dimensions are now stable (no internal scrolling), so a
    // double animation-frame pass is enough to measure the final DOM layout.
    // Do not schedule delayed recentering: a later pan makes Leaflet visibly
    // move/repaint the popup 1–3 seconds after opening, which looks like a
    // flicker on mobile.
    requestAnimationFrame(() => {
      requestAnimationFrame(center)
    })
  }

  // Exposed only for map actions such as route fitBounds(): those actions
  // intentionally move the map after the popup has opened, so the popup gets
  // one fresh centering pass without installing a permanent moveend listener.
  map._sosdzCenterOpenPopup = () => {
    if (openPopup) centerPopupOnScreen(openPopup)
  }

  const onOpen = (e) => {
    const popup = e.popup
    const popupEl = popup.getElement()
    openPopup = popup

    // A marker click is a deliberate interaction with the map. Open the
    // popup normally AND wake the map on that same first tap; the tap must
    // never be consumed by the "Touchez pour déplacer la carte" mode.
    onActivate?.()

    if (popupEl) {
      // Leaflet normally stops touch/mouse events on popup content. Allow
      // dragging from the popup body while keeping links/buttons clickable.
      L.DomEvent.off(popupEl, 'mousedown touchstart')

      popupEl.querySelectorAll('a, button, .leaflet-popup-close-button').forEach((control) => {
        if (control.dataset.mapDragGuard) return
        control.dataset.mapDragGuard = '1'
        const stop = (event) => event.stopPropagation()
        control.addEventListener('mousedown', stop)
        control.addEventListener('touchstart', stop, { passive: true })
      })
    }

    const btn = popupEl?.querySelector('.popup-photo-btn')
    if (btn && onPhoto) btn.onclick = () => onPhoto(btn.dataset.photoUrl)

    centerPopupOnScreen(popup)
  }

  const onClose = (e) => {
    if (e.popup === openPopup) openPopup = null
    if (e.popup) delete e.popup._sosdzRecenter
  }

  map.on('popupopen', onOpen)
  map.on('popupclose', onClose)
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
