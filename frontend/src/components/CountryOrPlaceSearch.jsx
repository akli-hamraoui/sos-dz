import { useState, useRef, useEffect } from 'react'
import { searchPlaces } from '../utils'
import { countryOptions } from '../countries'

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
export default function CountryOrPlaceSearch({ lang, placeholder, onSelectCountry, onSelectPlace }) {
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
      try {
        const results = await searchPlaces(trimmed, lang, controller.signal, 'any')
        setPlaceResults(results)
      } catch {
        // Network/CORS failure or a superseded request -- country
        // matches (computed locally, below) still show regardless.
      }
    }, 400)
  }

  const pickCountry = (c) => {
    setQuery(c.name)
    setOpen(false)
    setPlaceResults([])
    onSelectCountry(c.code, c.name)
  }

  const pickPlace = (p) => {
    setQuery(p.display_name)
    setOpen(false)
    setPlaceResults([])
    onSelectPlace({ lat: parseFloat(p.lat), lon: parseFloat(p.lon) })
  }

  const countries = countryMatches(query)

  return (
    <div className="place-autocomplete">
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => setOpen(countries.length > 0 || placeResults.length > 0)}
        onBlur={() => {
          // Same delay-before-close as PlaceAutocomplete/CountrySelect --
          // gives a suggestion's onMouseDown a moment to land first.
          blurTimeoutRef.current = setTimeout(() => setOpen(false), 150)
        }}
        placeholder={placeholder}
        autoComplete="off"
      />
      {open && (countries.length > 0 || placeResults.length > 0) && (
        <ul className="place-suggestions" role="listbox">
          {countries.map((c) => (
            <li key={'country-' + c.code} role="option" onMouseDown={() => pickCountry(c)}>
              🌐 {c.name}
            </li>
          ))}
          {placeResults.map((p) => (
            <li key={'place-' + p.place_id} role="option" onMouseDown={() => pickPlace(p)}>
              📍 {p.display_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
