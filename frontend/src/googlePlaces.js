// Google address / place suggestions (Places API "New"), used instead of
// OpenStreetMap's when Google Maps is enabled in Django Admin (see
// mapBase.js). Only the suggestion text comes back here; the exact
// position is fetched when one is picked (googlePlacePosition). Every call
// throws on any failure -- callers then fall back to OpenStreetMap.

import { loadGoogleMaps } from './mapBase'

// Google has no "anywhere but X" filter: suggestions ending with one of
// these country names are dropped instead (international forms, where
// Algeria has its own pages).
const COUNTRY_NAMES = { dz: ['algérie', 'algerie', 'algeria', 'الجزائر'] }

// countryCode: an ISO code, or 'any'. viewbox: Nominatim's [west, north,
// east, south]. types: Google's includedPrimaryTypes, e.g. ['(cities)'].
export async function searchGooglePlaces(query, { lang, countryCode = 'dz', excludeCountryCode, viewbox, types, sessionRef }) {
  await loadGoogleMaps()
  const { AutocompleteSuggestion, AutocompleteSessionToken } = await window.google.maps.importLibrary('places')
  if (!sessionRef.current) sessionRef.current = new AutocompleteSessionToken()
  const request = { input: query, sessionToken: sessionRef.current, language: lang }
  if (countryCode && countryCode !== 'any') {
    request.includedRegionCodes = [countryCode.toLowerCase()]
    request.region = countryCode.toLowerCase()
  }
  if (types) request.includedPrimaryTypes = types
  if (viewbox) {
    const [west, north, east, south] = viewbox
    request.locationRestriction = { west, south, east, north }
  }
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request)
  const excluded = COUNTRY_NAMES[excludeCountryCode?.toLowerCase()] || []
  return suggestions
    .filter((x) => x.placePrediction)
    .map((x) => ({ place_id: x.placePrediction.placeId, display_name: x.placePrediction.text.toString(), googlePrediction: x.placePrediction }))
    .filter((r) => !excluded.some((name) => r.display_name.toLowerCase().trim().endsWith(name)))
}

export async function googlePlacePosition(prediction) {
  const place = prediction.toPlace()
  await place.fetchFields({ fields: ['location'] })
  return place.location ? { lat: place.location.lat(), lon: place.location.lng() } : null
}
