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

// Bottom-nav notification badge text: exact under 100, rounded down to the
// nearest hundred with a "+" once it's not already a round number (223 ->
// "200+", 200 -> "200"), then the same idea in thousands past 999 (1500 ->
// "1k+", 2000 -> "2k") -- keeps the badge readable at a glance instead of
// squeezing an arbitrarily long exact number into a tiny pill.
export function formatBadgeCount(n) {
  if (n < 100) return String(n)
  if (n < 1000) {
    const rounded = Math.floor(n / 100) * 100
    return rounded === n ? String(rounded) : `${rounded}+`
  }
  const thousands = Math.floor(n / 1000)
  return n % 1000 === 0 ? `${thousands}k` : `${thousands}k+`
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

// Free-text place search via Nominatim (OpenStreetMap). Restricted to
// Algeria by default (countryCode omitted) for every national form; pass an
// ISO 3166-1 alpha-2 code to restrict to a different single country instead
// (InternationalCollectionPoints.jsx's country filter), or the literal
// string 'any' for a worldwide search with no restriction at all (that
// page's own "go to a place/street" search, so typing "Paris" or a street
// address works before a country is even picked). Best-effort only: any
// network/CORS failure just means no suggestions show up -- the caller
// always keeps whatever the visitor actually typed regardless (see
// components/PlaceAutocomplete.jsx), so a place that isn't in OSM's data
// never blocks a report from going through.
export async function searchPlaces(query, lang, signal, countryCode = 'dz') {
  const countryParam = countryCode === 'any' ? '' : `&countrycodes=${countryCode.toLowerCase()}`
  const url = `${NOMINATIM_BASE}/search?format=json&addressdetails=0&limit=6&accept-language=${lang}${countryParam}&q=${encodeURIComponent(query)}`
  const resp = await fetch(url, { signal })
  if (!resp.ok) throw new Error('Place search failed')
  return resp.json()
}

// Geocodes a whole country (by its ISO code) to a bounding box, so
// InternationalCollectionPoints.jsx can zoom its map to roughly the right
// place as soon as a country is picked from the filter, before any
// individual collection point or street search narrows it further.
// Best-effort: the caller falls back to a world view on any failure.
export async function geocodeCountryBounds(countryCode, lang) {
  // Nominatim's free-text `q` needs an actual place name -- querying it
  // with the bare ISO code (e.g. "FR") matches nothing, so this always
  // fell through to the world-view fallback. Look the country's own
  // localized name up the same way countries.js does, and search for
  // that instead; `countrycodes` still pins the result to the right
  // country if the name happens to collide with something else.
  let name = countryCode
  try {
    const displayNames = new Intl.DisplayNames([lang], { type: 'region' })
    name = displayNames.of(countryCode) || countryCode
  } catch {
    // Unsupported locale/browser -- fall back to searching the raw code.
  }
  const url = `${NOMINATIM_BASE}/search?format=json&addressdetails=0&limit=1&featureType=country&accept-language=${lang}&countrycodes=${countryCode.toLowerCase()}&q=${encodeURIComponent(name)}`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error('Country geocode failed')
  const data = await resp.json()
  const hit = data[0]
  if (!hit || !hit.boundingbox) return null
  const [south, north, west, east] = hit.boundingbox.map(Number)
  return { south, north, west, east }
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

// The browser's own native form-validation bubble ("Please fill out this
// field", "Please lengthen this text to 6 characters or more"...) is drawn
// by the browser itself, in the browser/OS's own language -- never the
// app's currently-selected language -- so a French/Arabic-language visitor
// on an English-locale browser would see it in English regardless. Spread
// this onto any <input>/<textarea>/<select> that has required/minLength/
// maxLength/type=email/pattern to replace that bubble's text with a real,
// translated one via the standard Constraint Validation API
// (setCustomValidity) -- the native bubble/positioning/timing stays
// exactly the same, only the message text changes. onInput clears it again
// as soon as the value changes, so a message set for one invalid attempt
// never lingers stale once the field becomes valid.
export function validityMessageProps(t) {
  const applyMessage = (e) => {
    const el = e.target
    const v = el.validity
    if (v.valid) {
      el.setCustomValidity('')
    } else if (v.valueMissing) {
      el.setCustomValidity(t('validation.required'))
    } else if (v.tooShort) {
      el.setCustomValidity(t('validation.tooShort', { min: el.minLength }))
    } else if (v.tooLong) {
      el.setCustomValidity(t('validation.tooLong', { max: el.maxLength }))
    } else if (v.typeMismatch && el.type === 'email') {
      el.setCustomValidity(t('validation.invalidEmail'))
    } else if (v.patternMismatch || v.typeMismatch) {
      el.setCustomValidity(t('validation.invalidFormat'))
    } else {
      el.setCustomValidity('')
    }
  }
  return {
    onInvalid: applyMessage,
    onInput: (e) => e.target.setCustomValidity(''),
  }
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
