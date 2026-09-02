// Builds a wa.me link from a phone number as an admin would naturally type
// it (local Algerian format, e.g. "0555 12 34 56") -- wa.me needs bare
// digits in international format with no leading 0, so a local-format
// leading 0 is swapped for Algeria's country code (213). A number already
// entered with a country code (213... or +213...) passes through as-is.
export function whatsappLink(phone) {
  const digits = (phone || '').replace(/\D/g, '')
  if (!digits) return null
  const intl = digits.startsWith('213') ? digits : digits.startsWith('0') ? '213' + digits.slice(1) : digits
  return `https://wa.me/${intl}`
}

// Google's documented "always works" link format -- opens the Google Maps
// app if installed (iOS/Android), else the web version. No API key needed
// since this is a plain search deep-link, not the JS/embed API.
export function googleMapsUrl(lat, lon) {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
}

export function maskPhone(phone, revealed) {
  if (!phone) return ''
  if (revealed) return phone
  if (phone.length <= 4) return phone
  return phone.slice(0, 4) + ' XX XX ' + phone.slice(-2)
}

export function formatDate(iso, locale) {
  if (!iso) return ''
  const d = new Date(iso)
  // Force Western/Latin digits (0123456789) even for Arabic: Algeria uses
  // Western numerals in everyday use, not Eastern Arabic-Indic digits
  // (٠١٢٣...) that "ar" would otherwise default to in most browsers.
  return (
    d.toLocaleDateString(locale, { numberingSystem: 'latn' }) +
    ' ' +
    d.toLocaleTimeString(locale, { numberingSystem: 'latn', hour: '2-digit', minute: '2-digit' })
  )
}

export function haversineKm([lat1, lon1], [lat2, lon2]) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function urgencyColor(u) {
  // Only two visual tiers: critical (red) vs everything else (orange) --
  // "low" is not reachable from the public create-need form (it only
  // ever sets 'medium' or 'critical'; low is admin-only), and a distinct
  // third color there just to represent that rare admin-set case caused
  // more confusion ("is orange a separate, less urgent tier?") than it
  // resolved. Kept as its own model/enum value, just no longer its own color.
  return { critical: '#d92626', medium: '#e08a1e', low: '#e08a1e' }[u] || '#555'
}

// Same bounding box as the backend's ALGERIA_BOUNDING_BOX
// (config/settings.py) -- used client-side only to decide whether a
// visitor's geolocation is worth centering a map on directly, never for
// any actual write validation (the backend is the source of truth there).
const ALGERIA_BOUNDS = { latMin: 18.9, latMax: 37.3, lonMin: -8.7, lonMax: 12.0 }

export function isInAlgeria(lat, lon) {
  return lat >= ALGERIA_BOUNDS.latMin && lat <= ALGERIA_BOUNDS.latMax && lon >= ALGERIA_BOUNDS.lonMin && lon <= ALGERIA_BOUNDS.lonMax
}

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org'

// Free-text place search via Nominatim (OpenStreetMap), restricted to
// Algeria. Best-effort only: any network/CORS failure just means no
// suggestions show up -- the caller always keeps whatever the visitor
// actually typed regardless (see components/PlaceAutocomplete.jsx), so a
// place that isn't in OSM's data never blocks a report from going through.
export async function searchPlaces(query, lang, signal) {
  const url = `${NOMINATIM_BASE}/search?format=json&countrycodes=dz&addressdetails=0&limit=6&accept-language=${lang}&q=${encodeURIComponent(query)}`
  const resp = await fetch(url, { signal })
  if (!resp.ok) throw new Error('Place search failed')
  return resp.json()
}

// Reverse-geocodes a GPS position into a human-readable place name --
// used to prefill the "place" field after a successful "use my location"
// capture. Best-effort: callers ignore failures (network/CORS/no result).
export async function reverseGeocodePlace(lat, lon, lang) {
  const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${lat}&lon=${lon}&accept-language=${lang}&zoom=16`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error('Reverse geocode failed')
  const data = await resp.json()
  return data.display_name || null
}

export async function compressPhoto(file) {
  try {
    const imageCompression = (await import('browser-image-compression')).default
    // maxSizeMB is enforced iteratively by the library (it re-encodes at a
    // lower quality/resolution as needed until under the cap), on top of
    // the maxWidthOrHeight/initialQuality starting point -- without it, an
    // unusually high-entropy photo (dense damage/rubble detail) could
    // still land well above what's reasonable to submit over a weak
    // connection despite already being downscaled once.
    return await imageCompression(file, { maxWidthOrHeight: 1280, initialQuality: 0.7, maxSizeMB: 3, useWebWorker: true, fileType: 'image/jpeg' })
  } catch {
    return file
  }
}
