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
  const critical = urgency === 'critical'
  const urgencyClass = critical ? ' need-marker-critical' : ' need-marker-noncritical'
  return L.divIcon({
    className: 'need-marker-icon',
    html: `<span class="need-marker-pin${urgencyClass}" style="background:${urgencyColor(urgency)}">${NEED_SOS_ICON}</span>`,
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
// pickup location doesn't visually imply that a transport is currently
// active.
export function truckIcon(L, color = TRUCK_GREEN, isLive = true) {
  const svg = TRUCK_SVG.replace('{color}', color)
  return L.divIcon({
    className: 'truck-marker-icon',
    html: `<span class="truck-marker-pin${isLive ? '' : ' truck-marker-pin-departure'}">${svg}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  })
}

export function flyerPopupButtonHtml(id) {
  return `<button type="button" class="flyer-popup-btn" data-flyer-id="${id}">Voir le besoin</button>`
}

export function attachMapPopupBehavior(map, navigate) {
  map.on('popupopen', (e) => {
    const btn = e.popup.getElement()?.querySelector('.flyer-popup-btn')
    if (!btn) return
    btn.addEventListener('click', () => navigate(`/needs/${btn.dataset.flyerId}`))
  })
}

export function attachMapTapToActivate(map, setMapActive) {
  map.on('click', () => setMapActive(true))
}
