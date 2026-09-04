// Real road-following directions (distance + ETA + a route line that
// follows actual streets, not a straight "as the crow flies" line) between
// two points, via OSRM (Open Source Routing Machine) -- the same open-data
// routing engine behind most non-Google routing UIs, using OpenStreetMap's
// road network. This is what "route tracing like Google Maps" means here:
// Google's own Directions API is a paid, API-key-gated service, so OSRM is
// the free/open equivalent, consistent with this project's NSFWJS/Leaflet
// choices elsewhere (real, open-source, no paid API).
//
// Defaults to the public OSRM demo server (router.project-osrm.org) --
// free, no API key, but not meant for heavy/production traffic. Override
// with VITE_OSRM_BASE_URL to point at a self-hosted OSRM instance (see
// DEPLOYMENT.md) once volume justifies it.

const OSRM_BASE_URL = import.meta.env.VITE_OSRM_BASE_URL || 'https://router.project-osrm.org'

// Shared color for every trajectory line drawn on a map in this app
// (Deliveries.jsx's courier-to-destination route, and any collection-point
// map's visitor-to-point route) -- one definition so they all stay in sync.
export const ROUTE_COLOR = '#c62828'

export async function fetchDrivingRoute([lat1, lon1], [lat2, lon2]) {
  const url = `${OSRM_BASE_URL}/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=full&geometries=geojson`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error('routing service unavailable')
  const data = await resp.json()
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('no route found')
  const route = data.routes[0]
  return {
    coordinates: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
    distanceKm: route.distance / 1000,
    durationMin: route.duration / 60,
  }
}
