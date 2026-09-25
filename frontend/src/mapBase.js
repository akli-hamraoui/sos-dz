// Map background for every Leaflet map of the site: OpenStreetMap (free,
// the default) or the official Google map (through Google's own Maps
// JavaScript API, via the GoogleMutant Leaflet layer), as picked in Django
// Admin (AppConfiguration.map_provider + google_maps_api_key, served by
// /api/config/ and handed over here by AppContext via setMapConfig). Pins,
// clusters, popups... are ours either way -- only the background changes.
//
// Google is best-effort: if its script can't load (network, blocked), the
// key is rejected, the daily quota set in Google Cloud is reached, or it
// just takes too long, every map switches to OpenStreetMap by itself --
// visitors never get a broken map, and nothing is billed past the quota.

import L from 'leaflet'
import GoogleMutant from 'leaflet.gridlayer.googlemutant/src/Leaflet.GoogleMutant.mjs'

const OSM_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION = '&copy; OpenStreetMap contributors'
const GOOGLE_LOAD_TIMEOUT_MS = 8000

let mapConfig = { map_provider: 'osm', google_maps_api_key: '' }
let googlePromise = null
let googleBroken = false
const liveMaps = new Set() // { map, apply } of every map on screen

function markGoogleBroken() {
  if (googleBroken) return
  googleBroken = true
  liveMaps.forEach((entry) => entry.apply())
}

// Called by AppContext whenever /api/config/ arrives or changes: maps
// already on screen switch background right away.
export function setMapConfig(config) {
  const next = { map_provider: config?.map_provider || 'osm', google_maps_api_key: config?.google_maps_api_key || '' }
  if (next.map_provider === mapConfig.map_provider && next.google_maps_api_key === mapConfig.google_maps_api_key) return
  mapConfig = next
  liveMaps.forEach((entry) => entry.apply())
}

export function googleMapsWanted() {
  return mapConfig.map_provider === 'google' && !!mapConfig.google_maps_api_key && !googleBroken
}

// Loads Google's script once for the whole site (map + Places library for
// the address suggestions). Rejects -- and marks Google unusable for this
// visit -- on any failure.
export function loadGoogleMaps() {
  if (!googleMapsWanted()) return Promise.reject(new Error('Google Maps not enabled'))
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google)
  if (!googlePromise) {
    googlePromise = new Promise((resolve, reject) => {
      // Called by Google on a bad/unauthorized key -- possibly well after
      // the script loaded, so it also switches maps already shown.
      window.gm_authFailure = markGoogleBroken
      const callback = '__sosdzGoogleMapsReady'
      window[callback] = () => resolve(window.google)
      const lang = (document.documentElement.lang || 'fr').slice(0, 2)
      const script = document.createElement('script')
      script.async = true
      script.src =
        `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapConfig.google_maps_api_key)}` +
        `&loading=async&libraries=places&v=weekly&language=${lang}&region=DZ&callback=${callback}`
      script.onerror = () => reject(new Error('Google Maps script failed to load'))
      document.head.appendChild(script)
      setTimeout(() => reject(new Error('Google Maps took too long to load')), GOOGLE_LOAD_TIMEOUT_MS)
    }).catch((error) => {
      markGoogleBroken()
      throw error
    })
  }
  return googlePromise
}

// Over quota / key refused after load: Google draws its own error box
// instead of the map (not always reported through gm_authFailure) -- look
// for it a few times after a Google background is added.
function watchForGoogleErrors() {
  ;[2500, 6000, 12000].forEach((ms) =>
    setTimeout(() => {
      if (!googleBroken && document.querySelector('.gm-err-container, .gm-err-message')) markGoogleBroken()
    }, ms)
  )
}

// Adds the background to `map` (and keeps it in line with the config).
// `osmOptions` are extra L.tileLayer options for the OpenStreetMap case.
export function addBaseLayer(map, osmOptions = {}) {
  let layer = null
  let kind = null
  const setLayer = (next, nextKind) => {
    if (!map._container) return // map already removed
    if (layer) map.removeLayer(layer)
    layer = next.addTo(map)
    kind = nextKind
  }
  const entry = {
    map,
    apply() {
      if (!googleMapsWanted()) {
        if (kind !== 'osm') setLayer(L.tileLayer(OSM_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19, ...osmOptions }), 'osm')
        return
      }
      if (kind === 'google') return
      // OpenStreetMap right away, swapped for Google once it's ready.
      if (!kind) setLayer(L.tileLayer(OSM_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19, ...osmOptions }), 'osm')
      loadGoogleMaps()
        .then(() => {
          if (!googleMapsWanted() || kind === 'google') return
          setLayer(new GoogleMutant({ type: 'roadmap', maxZoom: 21 }), 'google')
          watchForGoogleErrors()
        })
        .catch(() => entry.apply())
    },
  }
  liveMaps.add(entry)
  map.on('unload', () => liveMaps.delete(entry))
  entry.apply()
}
