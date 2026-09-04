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

export function collectionPointIcon(L) {
  return L.divIcon({
    className: 'cp-marker-icon',
    html: `<span class="cp-marker-pin">${CP_BOX_SVG}</span>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  })
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
    `<strong>${p.point_name}</strong><br>${p.contact_name}${p.organization ? '<br>' + p.organization : ''}` +
    `${p.hours ? '<br>' + p.hours : ''}<br>${p.wilaya_name}${gpsNote}<br><a href="/collection-points/${p.id}">${t('common.open')}</a>`
  )
}
