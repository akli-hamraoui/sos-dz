// Wilaya-level geography for the address fields (Signali): the wilaya's
// real extent (so suggestions are searched inside it), whether a
// suggestion lies in it, and which wilaya a GPS position is in. OSM's
// boundaries (via Nominatim) first, the wilaya centroids of our own table
// as the fallback -- everything here is best-effort.

const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org'

// "Béjaïa" / "Wilaya de Béjaïa" / "BEJAIA" -> "bejaia"
export function normalizeName(s) {
  return (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bwilaya (de |d'|d’)?|\bprovince (de |d'|d’|of )?|\bprovince\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function nearestByCentroid(lat, lon, wilayas) {
  let best = null
  let bestDist = Infinity
  wilayas.forEach((w) => {
    if (w.centroid_latitude == null) return
    const d = (w.centroid_latitude - lat) ** 2 + (w.centroid_longitude - lon) ** 2
    if (d < bestDist) {
      best = w
      bestDist = d
    }
  })
  return best
}

// OSM tags each wilaya "DZ-<code>" (ISO 3166-2), the same code as ours.
function byIsoCode(iso, wilayas) {
  const m = /^DZ-(\d{1,2})$/i.exec(iso || '')
  return m ? wilayas.find((w) => Number(w.code) === Number(m[1])) : null
}

// The wilaya's bounding box, Nominatim's [west, north, east, south]
// (viewbox order), cached for the visit. Centroid +- a margin when OSM
// can't be reached (wider in the Sahara, where wilayas are huge).
const boundsCache = new Map()
export function wilayaBounds(wilaya) {
  if (!wilaya) return Promise.resolve(null)
  const fallback = () => {
    if (wilaya.centroid_latitude == null) return null
    const span = wilaya.centroid_latitude < 32 ? 4 : 0.9
    const { centroid_latitude: la, centroid_longitude: lo } = wilaya
    return [lo - span, la + span, lo + span, la - span]
  }
  if (!boundsCache.has(wilaya.id)) {
    const url = `${NOMINATIM_BASE}/search?format=json&limit=1&countrycodes=dz&featureType=state&accept-language=fr&q=${encodeURIComponent(wilaya.name)}`
    boundsCache.set(
      wilaya.id,
      fetch(url)
        .then((r) => (r.ok ? r.json() : []))
        .then((found) => {
          const bb = found?.[0]?.boundingbox?.map(Number) // [south, north, west, east]
          if (!bb || bb.some((x) => !Number.isFinite(x))) return fallback()
          const [south, north, west, east] = bb
          // Sanity check: the box must hold our own centroid.
          const la = wilaya.centroid_latitude
          const lo = wilaya.centroid_longitude
          if (la != null && (la < south || la > north || lo < west || lo > east)) return fallback()
          return [west, north, east, south]
        })
        .catch(() => {
          boundsCache.delete(wilaya.id) // retry next time
          return fallback()
        })
    )
  }
  return boundsCache.get(wilaya.id)
}

// Whether an address suggestion lies in `wilaya`:
// - OSM results carry their wilaya (ISO code, or its name) -- exact;
// - Google's only carry text: dropped when they name another wilaya
//   (the search itself is already limited to the wilaya's box);
// - otherwise, the nearest wilaya centroid.
export function resultInWilaya(r, wilaya, wilayas) {
  if (!wilaya) return true
  const address = r.address || {}
  const iso = byIsoCode(address['ISO3166-2-lvl4'], wilayas)
  if (iso) return iso.id === wilaya.id
  const target = normalizeName(wilaya.name)
  const state = normalizeName(address.state)
  if (state) {
    if (state === target) return true
    // Spelled differently from ours ("El Taref" / "El Tarf"): decided by
    // the centroid below rather than dropped.
    if (wilayas.some((w) => normalizeName(w.name) === state)) return false
  }
  if (r.googlePrediction) {
    const text = ` ${normalizeName(r.display_name)} `
    if (text.includes(` ${target} `)) return true
    return !wilayas.some((w) => w.id !== wilaya.id && text.includes(` ${normalizeName(w.name)} `))
  }
  if (r.lat != null && r.lon != null) return nearestByCentroid(parseFloat(r.lat), parseFloat(r.lon), wilayas)?.id === wilaya.id
  return true
}

// The wilaya a position is in: OSM's reverse geocoding (its boundaries),
// else the nearest centroid.
export async function detectWilaya(lat, lon, wilayas) {
  try {
    const resp = await fetch(`${NOMINATIM_BASE}/reverse?format=json&zoom=5&addressdetails=1&accept-language=fr&lat=${lat}&lon=${lon}`)
    if (resp.ok) {
      const found = await resp.json()
      const w = byIsoCode(found?.address?.['ISO3166-2-lvl4'], wilayas)
      if (w) return w
      const state = normalizeName(found?.address?.state)
      const byName = state && wilayas.find((x) => normalizeName(x.name) === state)
      if (byName) return byName
    }
  } catch {
    // offline / blocked: the centroid below
  }
  return nearestByCentroid(lat, lon, wilayas)
}
