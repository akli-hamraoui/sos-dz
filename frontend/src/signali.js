import { loadJSON, saveJSON } from './api'

// Shared by the Signali wizard (pages/Signali.jsx) and the Signalements
// map (pages/Signalements.jsx). Same codes as core.models.Signalement.
export const SIGNALI_CATEGORIES = ['electricity', 'road', 'lighting', 'water', 'waste', 'signage', 'other']

// Same codes as core.models.Signalement.STATUS_CHOICES.
export const SIGNALI_STATUSES = ['new', 'in_review', 'resolved', 'cancelled']

const EMOJI = { electricity: '⚡', road: '🕳️', lighting: '💡', water: '💧', waste: '🗑️', signage: '🚧', other: '⚠️' }

export function categoryEmoji(category) {
  return EMOJI[category] || EMOJI.other
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
