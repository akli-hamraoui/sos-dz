import { useState, useRef, useEffect } from 'react'
import { searchPlaces, searchPlacesTypeahead } from '../utils'
import { countryOptions } from '../countries'

// Nominatim's own display_name is a full postal-style address (street,
// suburb, county, region, country -- see the screenshot that prompted
// this), which is unreadable clutter in a "type a city or country"
// field. Reduce each result to just the city (or the country alone when
// there's no city, e.g. the query itself matched a country) using the
// { address: { city, country, country_code } } shape both
// searchPlacesTypeahead and searchPlaces (utils.js) normalize their
// results to.
function placeLabel(p) {
  const addr = p.address || {}
  const city = addr.city || addr.town || addr.village || addr.municipality
  const country = addr.country
  if (city && country) return `${city}, ${country}`
  return city || country || p.display_name
}

// A single field for InternationalCollectionPoints.jsx's toolbar that
// merges what used to be two separate controls -- "go to a place" (a
// PlaceAutocomplete over Nominatim) and "filter by country" (a
// CountrySelect over the local country list) -- since a visitor
// browsing by location naturally wants to type either a city ("Paris")
// or a whole country ("France") in the same box rather than hunt for
// the right one of two fields first.
//
// Suggestions mix both sources: the local country list (instant,
// synchronous, no network) and a debounced worldwide Nominatim place
// search, shown together with a marker (🌐/📍) so it's clear which kind
// each entry is. Picking either calls the matching callback -- the
// parent decides what a country vs. a place selection actually does
// (list-filtering by country vs. just recentering the map), this
// component only tells it which one was picked.
export default function CountryOrPlaceSearch({ lang, placeholder, onSelectCountry, onSelectPlace, excludeCountryCode }) {
  const [query, setQuery] = useState('')
  const [placeResults, setPlaceResults] = useState([])
  const [open, setOpen] = useState(false)
  const debounceRef = useRef(null)
  const abortRef = useRef(null)
  const blurTimeoutRef = useRef(null)

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current)
      if (abortRef.current) abortRef.current.abort()
    },
    []
  )

  const countryMatches = (text) => {
    const q = text.trim().toLowerCase()
    if (!q) return []
    return countryOptions(lang)
      .filter((c) => c.name.toLowerCase().includes(q))
      .slice(0, 5)
  }

  const handleChange = (e) => {
    const next = e.target.value
    setQuery(next)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = next.trim()
    if (trimmed.length < 2) {
      setPlaceResults([])
      setOpen(false)
      return
    }
    setOpen(true)
    debounceRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort()
      const controller = new AbortController()
      abortRef.current = controller
      // Photon (searchPlacesTypeahead) is the primary source -- it
      // handles partial/hyphenated place names correctly, unlike
      // Nominatim (see utils.js). Fall back to Nominatim whenever Photon
      // comes back empty OR fails outright (network error, outage), so
      // neither a genuine no-match nor a Photon-specific failure leaves
      // the field worse off than before this switch.
      let results = []
      try {
        results = await searchPlacesTypeahead(trimmed, lang, controller.signal)
        if (excludeCountryCode) {
          results = results.filter((r) => r.address.country_code?.toLowerCase() !== excludeCountryCode.toLowerCase())
        }
      } catch {
        // Superseded request or Photon failure -- try Nominatim below.
      }
      if (results.length === 0) {
        try {
          results = await searchPlaces(trimmed, lang, controller.signal, 'any', excludeCountryCode)
        } catch {
          // Both providers failed, or this request was superseded --
          // country matches (computed locally, below) still show
          // regardless, and previous place results are left as-is.
          return
        }
      }
      setPlaceResults(results)
    }, 400)
  }

  const pickCountry = (c) => {
    setQuery(c.name)
    setOpen(false)
    setPlaceResults([])
    onSelectCountry(c.code, c.name)
  }

  const pickPlace = (p) => {
    setQuery(placeLabel(p))
    setOpen(false)
    setPlaceResults([])
    onSelectPlace({ lat: parseFloat(p.lat), lon: parseFloat(p.lon) })
  }

  const countries = countryMatches(query)
  // Different Nominatim entries (e.g. a relation and a node for the same
  // city) often collapse to the same simplified label once addresses are
  // reduced to city/country -- dedupe so the list doesn't show the same
  // text twice.
  const seenLabels = new Set()
  const places = placeResults.filter((p) => {
    const label = placeLabel(p)
    if (seenLabels.has(label)) return false
    seenLabels.add(label)
    return true
  })

  return (
    <div className="place-autocomplete">
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => setOpen(countries.length > 0 || places.length > 0)}
        onBlur={() => {
          // Same delay-before-close as PlaceAutocomplete/CountrySelect --
          // gives a suggestion's onMouseDown a moment to land first.
          blurTimeoutRef.current = setTimeout(() => setOpen(false), 150)
        }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && (countries.length > 0 || places.length > 0) && (
        <ul className="place-suggestions" role="listbox">
          {countries.map((c) => (
            <li key={'country-' + c.code} role="option" onMouseDown={() => pickCountry(c)}>
              🌐 {c.name}
            </li>
          ))}
          {places.map((p) => (
            <li key={'place-' + p.place_id} role="option" onMouseDown={() => pickPlace(p)}>
              📍 {placeLabel(p)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
