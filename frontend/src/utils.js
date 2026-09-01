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
  return { critical: '#d92626', medium: '#e08a1e', low: '#cbb400' }[u] || '#555'
}

// Same bounding box as the backend's ALGERIA_BOUNDING_BOX
// (config/settings.py) -- used client-side only to decide whether a
// visitor's geolocation is worth centering a map on directly, never for
// any actual write validation (the backend is the source of truth there).
const ALGERIA_BOUNDS = { latMin: 18.9, latMax: 37.3, lonMin: -8.7, lonMax: 12.0 }

export function isInAlgeria(lat, lon) {
  return lat >= ALGERIA_BOUNDS.latMin && lat <= ALGERIA_BOUNDS.latMax && lon >= ALGERIA_BOUNDS.lonMin && lon <= ALGERIA_BOUNDS.lonMax
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
