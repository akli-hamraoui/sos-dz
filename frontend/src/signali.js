import { loadJSON, saveJSON } from './api'

// Shared by the Signali wizard (pages/Signali.jsx) and the Signalements
// map (pages/Signalements.jsx). Same codes as core.models.Signalement.
export const SIGNALI_CATEGORIES = ['pothole', 'road', 'waste', 'sewer', 'water', 'electricity', 'lighting', 'signage', 'danger', 'other']

// Same codes as core.models.Signalement.STATUS_CHOICES.
export const SIGNALI_STATUSES = ['new', 'in_review', 'resolved', 'cancelled']

const EMOJI = {
  pothole: '🕳️',
  road: '🛣️',
  waste: '🗑️',
  // No sewer emoji exists (🚽 is a toilet): text-only spots (<option>)
  // get this, everything else draws a pipe pouring into water (categoryIconHtml).
  sewer: '🌊',
  water: '💧',
  electricity: '⚡',
  lighting: '💡',
  signage: '🚧',
  danger: '⚠️',
  other: '📌',
}

export function categoryEmoji(category) {
  return EMOJI[category] || EMOJI.other
}

// Sewer: an elbow pipe pouring wastewater into waves, sized like the text
// around it (1em).
const SEWER_SVG =
  '<svg class="signali-cat-svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M1 2.5h10.5a7 7 0 0 1 7 7V12h-5V9.5a2 2 0 0 0-2-2H1Z" fill="#9aa6b3"/>' +
  '<path d="M1 3.6h10.5a5.9 5.9 0 0 1 5.9 5.9V12" fill="none" stroke="#c9d1da" stroke-width="1"/>' +
  '<rect x="8.4" y="1.4" width="2.2" height="7.2" rx=".7" fill="#5b6673"/>' +
  '<rect x="12.6" y="11.2" width="6.8" height="2.2" rx=".7" fill="#5b6673"/>' +
  '<path d="M14 13.4h4.2l.6 5.2h-5.4Z" fill="#8a6a3a"/>' +
  '<path d="M1 18.6c1.6-1.4 3.2-1.4 4.8 0s3.2 1.4 4.8 0 3.2-1.4 4.8 0 3.2 1.4 4.8 0 2.4-1 3.4-.6" fill="none" stroke="#7a8f3c" stroke-width="1.8" stroke-linecap="round"/>' +
  '<path d="M1 22c1.6-1.4 3.2-1.4 4.8 0s3.2 1.4 4.8 0 3.2-1.4 4.8 0 3.2 1.4 4.8 0 2.4-1 3.4-.6" fill="none" stroke="#5a7d8c" stroke-width="1.8" stroke-linecap="round"/></svg>'

// The category's icon as HTML: its emoji, or a drawing when no emoji fits.
// For Leaflet divIcons/popups and (via CategoryIcon) React.
export function categoryIconHtml(category) {
  return category === 'sewer' ? SEWER_SVG : categoryEmoji(category)
}

// A report's access token lets its (anonymous) reporter close it as
// "fixed" right away from this device -- kept per id, like need tokens.
const TOKENS_KEY = 'signalementTokens'

export function saveSignalementToken(id, token) {
  try {
    const tokens = { ...loadJSON(TOKENS_KEY, {}), [id]: token }
    if (!token) delete tokens[id]
    saveJSON(TOKENS_KEY, tokens)
  } catch {
    /* private mode / storage full: the report is still sent */
  }
}

export function getSignalementToken(id) {
  return loadJSON(TOKENS_KEY, {})[id] || null
}

// Ids of reports sent from this device (their reporter can see them on
// the map even while they're still being checked).
export function getOwnSignalementIds() {
  return Object.keys(loadJSON(TOKENS_KEY, {})).map(Number).filter(Boolean)
}

// The "Signal" megaphone (same drawing as IconMegaphone in icons.jsx, used
// for the bottom-nav tab), as a plain string for Leaflet divIcons.
export function signalIconSvg(size = 22, color = '#fff') {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    '<path d="M3.5 10.2v3.6a1 1 0 0 0 1 1H7l7.5 4.2V5L7 9.2H4.5a1 1 0 0 0-1 1Z"/><path d="M7.5 14.8 9 20h2.3"/>' +
    '<path d="M18 9.2a4 4 0 0 1 0 5.6M20.3 7a7.2 7.2 0 0 1 0 10"/></svg>'
  )
}
export const SIGNAL_ICON_SVG = signalIconSvg()
