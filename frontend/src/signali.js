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
  // get this, everything else draws a plumbing pipe (categoryIconHtml).
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

// A plumbing pipe (elbow + flanges) dripping water, sized like the text
// around it (1em).
const PIPE_SVG =
  '<svg class="signali-cat-svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M1.5 4.5h13a5.5 5.5 0 0 1 5.5 5.5v6h-6v-5.5a.5.5 0 0 0-.5-.5h-12Z" fill="#8b98a6"/>' +
  '<path d="M1.5 5.6h13a4.4 4.4 0 0 1 4.4 4.4v6" fill="none" stroke="#c3ccd6" stroke-width="1.1"/>' +
  '<rect x="4.2" y="3.2" width="2.4" height="8.6" rx=".8" fill="#56616e"/>' +
  '<rect x="12.8" y="14.2" width="8.4" height="2.6" rx=".8" fill="#56616e"/>' +
  '<path d="M17 18.2c.9 1.3 1.5 2.1 1.5 2.8a1.5 1.5 0 0 1-3 0c0-.7.6-1.5 1.5-2.8Z" fill="#2f8fe0"/></svg>'

// The category's icon as HTML: its emoji, or a drawing when no emoji fits.
// For Leaflet divIcons/popups and (via CategoryIcon) React.
export function categoryIconHtml(category) {
  return category === 'sewer' ? PIPE_SVG : categoryEmoji(category)
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
