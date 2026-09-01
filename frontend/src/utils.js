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

export async function compressPhoto(file) {
  try {
    const imageCompression = (await import('browser-image-compression')).default
    return await imageCompression(file, { maxWidthOrHeight: 1280, initialQuality: 0.7, useWebWorker: true, fileType: 'image/jpeg' })
  } catch {
    return file
  }
}
