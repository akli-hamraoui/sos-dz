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
