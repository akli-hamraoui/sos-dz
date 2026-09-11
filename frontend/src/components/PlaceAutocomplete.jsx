import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { searchPlaces } from '../utils'

// A free-text place input with map-backed suggestions (OpenStreetMap
// Nominatim, French/Arabic/English depending on the current locale).
// Never blocks on a match: whatever the visitor typed is always what
// gets saved, suggestions are purely a convenience for finding the exact
// spelling/spot faster.
export default function PlaceAutocomplete({ value, onChange, onSelectPlace, placeholder, as = 'input', required = false, id, onInvalid, countryCode, excludeCountryCode }) {
  const { i18n } = useTranslation()
  const [suggestions, setSuggestions] = useState([])
  const [open, setOpen] = useState(false)
  const abortRef = useRef(null)
  const debounceRef = useRef(null)
  const blurTimeoutRef = useRef(null)

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
        const results = await searchPlaces(next.trim(), i18n.language, controller.signal, countryCode, excludeCountryCode)
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
        <ul className="place-suggestions" role="listbox">
          {suggestions.map((s) => (
            <li key={s.place_id} role="option" onMouseDown={() => selectSuggestion(s)}>
              {s.display_name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
