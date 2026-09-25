import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { searchPlaces, searchPlacesPrefix } from '../utils'
import { IconClose } from '../icons'
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
    const [west, north, east, south] = viewbox // Nominatim's order
    request.locationRestriction = { west, south, east, north }
  }
  const { suggestions } = await AutocompleteSuggestion.fetchAutocompleteSuggestions(request)
  return suggestions
    .filter((x) => x.placePrediction)
    .map((x) => ({ place_id: x.placePrediction.placeId, display_name: x.placePrediction.text.toString(), googlePrediction: x.placePrediction }))
}

const MAX_SUGGESTIONS = 10

function mergeSuggestions(...lists) {
  const seen = new Set()
  const out = []
  for (const list of lists)
    for (const r of list || []) {
      const key = (r.display_name || '').toLowerCase().replace(/\s+/g, ' ').trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(r)
      if (out.length >= MAX_SUGGESTIONS) return out
    }
  return out
}

async function googlePlacePosition(prediction) {
  const place = prediction.toPlace()
  await place.fetchFields({ fields: ['location'] })
  return place.location ? { lat: place.location.lat(), lon: place.location.lng() } : null
}

// A free-text place input with map-backed suggestions (OpenStreetMap
// Nominatim, French/Arabic/English depending on the current locale).
// Up to MAX_SUGGESTIONS suggestions: Google's (5 at most) or Nominatim's
// first, topped up with Photon's prefix matches, duplicates dropped.
// Never blocks on a match: whatever the visitor typed is always what
// gets saved, suggestions are purely a convenience for finding the exact
// spelling/spot faster.
// `viewbox` / `filterResult` (optional): keep suggestions inside an area,
// e.g. Signali's selected wilaya.
export default function PlaceAutocomplete({ value, onChange, onSelectPlace, placeholder, as = 'input', required = false, id, onInvalid, countryCode, excludeCountryCode, viewbox, filterResult }) {
  const { t, i18n } = useTranslation()
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
        const q = next.trim()
        const keep = (list) => (filterResult ? list.filter(filterResult) : list)
        // Google when enabled (never for the "anywhere but Algeria" search,
        // which Google can't express) -- OpenStreetMap otherwise, or if
        // Google fails. OpenStreetMap's prefix search tops the list up.
        const google = googleMapsWanted() && !excludeCountryCode ? searchGooglePlaces(q, i18n.language, countryCode ?? 'dz', viewbox, googleSessionRef).catch(() => null) : null
        const nominatim = searchPlaces(q, i18n.language, controller.signal, countryCode, excludeCountryCode, viewbox).catch(() => [])
        const prefix = excludeCountryCode ? Promise.resolve([]) : searchPlacesPrefix(q, i18n.language, controller.signal, countryCode ?? 'dz', viewbox).catch(() => [])
        const [g, n, ph] = await Promise.all([google, nominatim, prefix])
        if (controller.signal.aborted) return
        const results = mergeSuggestions(g, keep(n), keep(ph))
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
  const fieldRef = useRef(null)
  const clear = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (abortRef.current) abortRef.current.abort()
    onChange('')
    setSuggestions([])
    setOpen(false)
    fieldRef.current?.focus()
  }

  return (
    <div className={`place-autocomplete${value ? ' has-value' : ''}`}>
      <Field
        ref={fieldRef}
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
      {value && (
        <button
          type="button"
          className="place-autocomplete-clear"
          // Keeps the focus (and the phone keyboard) in the field.
          onMouseDown={(e) => e.preventDefault()}
          onClick={clear}
          aria-label={t('common.clear')}
          title={t('common.clear')}
        >
          <IconClose width={16} height={16} />
        </button>
      )}
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
