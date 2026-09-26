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

// The last config seen, kept for the next visit: maps then open straight
// on the right background instead of waiting for /api/config/ (which used
// to mean OpenStreetMap first, then a swap to Google).
const CONFIG_KEY = 'sosdz.mapConfig'
function readSavedConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null')
    if (saved?.map_provider) return saved
  } catch {
    // private mode, blocked storage: OpenStreetMap until the config arrives
  }
  return { map_provider: 'osm', google_maps_api_key: '' }
}
let mapConfig = readSavedConfig()
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
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(next))
  } catch {
    // not saved: the next visit just waits for the config again
  }
  preloadGoogleMaps()
  liveMaps.forEach((entry) => entry.apply())
}

// Starts loading Google's script as soon as it's known to be wanted (app
// start, once the page has painted) rather than when the first map opens:
// the map then shows up with Google already there. Loading the script
// isn't billed -- only showing a map is.
function preloadGoogleMaps() {
  if (!googleMapsWanted() || googlePromise) return
  const start = () => loadGoogleMaps().catch(() => {})
  if (window.requestIdleCallback) window.requestIdleCallback(start, { timeout: 1500 })
  else setTimeout(start, 300)
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
    if (layer) {
      map.removeLayer(layer)
      // An attribution control added after this layer (the maps add theirs
      // right after addBaseLayer) doesn't drop its credit on removal by
      // itself: "© OpenStreetMap" stayed under the Google map. Harmless
      // when it already did (the count doesn't go below zero).
      if (layer.getAttribution?.()) map.attributionControl?.removeAttribution(layer.getAttribution())
    }
    layer = next.addTo(map)
    kind = nextKind
  }
  const osm = () => L.tileLayer(OSM_URL, { attribution: OSM_ATTRIBUTION, maxZoom: 19, ...osmOptions })
  const google = () => new GoogleMutant({ type: 'roadmap', maxZoom: 21 })
  // Google laid over the OpenStreetMap already shown, which is only taken
  // away once Google has drawn its tiles (or after a few seconds) -- no
  // grey gap in between.
  const swapToGoogle = () => {
    const previous = layer
    layer = null
    setLayer(google(), 'google')
    watchForGoogleErrors()
    if (!previous) return
    let dropped = false
    const dropPrevious = () => {
      if (dropped) return
      dropped = true
      // Back on OpenStreetMap meanwhile (Google failed): nothing to drop.
      if (!map._container || kind !== 'google') return
      map.removeLayer(previous)
      if (previous.getAttribution?.()) map.attributionControl?.removeAttribution(previous.getAttribution())
    }
    layer.once('load', dropPrevious)
    setTimeout(dropPrevious, 4000)
  }
  const entry = {
    map,
    apply() {
      if (!googleMapsWanted()) {
        if (kind !== 'osm') setLayer(osm(), 'osm')
        return
      }
      if (kind === 'google') return
      // Google's script already there (preloaded): Google straight away.
      if (!kind && window.google?.maps?.Map) {
        setLayer(google(), 'google')
        watchForGoogleErrors()
        return
      }
      // Otherwise OpenStreetMap right away, Google over it once ready.
      if (!kind) setLayer(osm(), 'osm')
      loadGoogleMaps()
        .then(() => {
          if (!googleMapsWanted() || kind === 'google') return
          swapToGoogle()
        })
        .catch(() => entry.apply())
    },
  }
  liveMaps.add(entry)
  map.on('unload', () => liveMaps.delete(entry))
  entry.apply()
}

preloadGoogleMaps()
