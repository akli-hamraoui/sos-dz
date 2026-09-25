import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { searchPlaces } from '../utils'
import { googleMapsWanted, loadGoogleMaps } from '../mapBase'

// Google address suggestions (Places API "New"), used instead of
// OpenStreetMap's when Google Maps is enabled in Django Admin. Only the
// suggestion text comes back here; the exact position is fetched when one
// is picked (googlePlacePosition). Throws on any failure -- the caller then
// falls back to OpenStreetMap.
async function searchGooglePlaces(query, lang, countryCode, viewbox, sessionRef) {
  await loadGoogleMaps()
  const { AutocompleteSuggestion, AutocompleteSessionToken } = await window.google.maps.importLibrary('places')
  if (!sessionRef.current) sessionRef.current = new AutocompleteSessionToken()
  const request = { input: query, sessionToken: sessionRef.current, language: lang, region: 'dz' }
  if (countryCode && countryCode !== 'any') request.includedRegionCodes = [countryCode.toLowerCase()]
  if (viewbox) {
    const [west, south, east, north] = viewbox
    request.locationRestriction = { west, south, east, north }
  }
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request)
  return suggestions
    .filter((x) => x.placePrediction)
    .map((x) => ({ place_id: x.placePrediction.placeId, display_name: x.placePrediction.text.toString(), googlePrediction: x.placePrediction }))
}

async function googlePlacePosition(prediction) {
  const place = prediction.toPlace()
  await place.fetchFields({ fields: ['location'] })
  return place.location ? { lat: place.location.lat(), lon: place.location.lng() } : null
}

// A free-text place input with map-backed suggestions (OpenStreetMap
// Nominatim, French/Arabic/English depending on the current locale).
// Never blocks on a match: whatever the visitor typed is always what
// gets saved, suggestions are purely a convenience for finding the exact
// spelling/spot faster.
// `viewbox` / `filterResult` (optional): keep suggestions inside an area,
// e.g. Signali's selected wilaya.
export default function PlaceAutocomplete({ value, onChange, onSelectPlace, placeholder, as = 'input', required = false, id, onInvalid, countryCode, excludeCountryCode, viewbox, filterResult }) {
  const { i18n } = useTranslation()
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const abortRef = useRef(null)
  const debounceRef = useRef(null)
  const blurTimeoutRef = useRef(null)
  const googleSessionRef = useRef(null) // one Google billing session per search, closed by the pick

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
      if (abortRef.current) abortRef.current.abort()
    },
    []
  )

  const handleChange = (e) => {
    const next = e.target.value
    e.target.setCustomValidity('') // clears any translated required-field message set via onInvalid below
    onChange(next)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (next.trim().length < 2) {
      setSuggestions([])
      setOpen(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller
      try {
        let results = null
        // Google when enabled (never for the "anywhere but Algeria" search,
        // which Google can't express) -- OpenStreetMap otherwise, or if
        // Google fails.
        if (googleMapsWanted() && !excludeCountryCode) {
          try {
            results = await searchGooglePlaces(next.trim(), i18n.language, countryCode ?? 'dz', viewbox, googleSessionRef)
          } catch {
            results = null
          }
        }
        if (controller.signal.aborted) return
        if (!results) {
          const found = await searchPlaces(next.trim(), i18n.language, controller.signal, countryCode, excludeCountryCode, viewbox)
          results = filterResult ? found.filter(filterResult) : found
        }
        setSuggestions(results)
        setOpen(results.length > 0)
      } catch {
        // Network/CORS failure or a superseded request -- no suggestions,
        // the freetext the visitor already typed is unaffected.
      }
    }, 400)
  }

  const selectSuggestion = (s) => {
    onChange(s.display_name)
    if (s.googlePrediction) {
      googleSessionRef.current = null
      if (onSelectPlace) googlePlacePosition(s.googlePrediction).then((pos) => pos && onSelectPlace(pos)).catch(() => {})
      setSuggestions([])
      setOpen(false)
      return
    }
    // A suggestion picked from the map carries real coordinates, unlike
    // plain freetext -- callers use this to also capture an exact GPS
    // position (e.g. so "sans position GPS exacte" doesn't show up for a
    // need whose location was set this way instead of via "Ma position").
    if (onSelectPlace && s.lat != null && s.lon != null) {
      onSelectPlace({ lat: parseFloat(s.lat), lon: parseFloat(s.lon) })
    }
    setSuggestions([])
    setOpen(false)
  }

  const Field = as === 'textarea' ? 'textarea' : 'input'

  return (
    <div className="place-autocomplete">
      <Field
        id={id}
        type={as === 'textarea' ? undefined : 'text'}
        value={value}
        onChange={handleChange}
        onFocus={() => setOpen(suggestions.length > 0)}
        onBlur={() => {
          // A plain onClick on the suggestion would fire after this blur
          // (which already closed the list), so selection uses onMouseDown
          // instead -- this delay just gives that a moment to land first.
          blurTimeoutRef.current = setTimeout(() => setOpen(false), 150)
        }}
        placeholder={placeholder}
        required={required}
        onInvalid={onInvalid}
        autoComplete="off"
      />
      {open && (
        <ul
          className="place-suggestions"
          role="listbox"
          // See CountryOrPlaceSearch.jsx's own identical guard -- a touch
          // scroll inside this list can trigger the field's blur, whose
          // 150ms timer would otherwise close the list mid-scroll.
          onTouchStart={() => {
            if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
          }}
        >
          {suggestions.map((s) => (
            <li key={s.place_id} role="option" onMouseDown={() => selectSuggestion(s)}>
              {s.display_name}
            </li>
          ))}
          {/* Google's terms: its suggestions carry its name. */}
          {suggestions.some((s) => s.googlePrediction) && (
            <li className="place-suggestions-credit" aria-hidden="true">
              Google
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
