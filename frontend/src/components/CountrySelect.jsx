import { useState, useRef, useEffect } from 'react'
import { countryOptions } from '../countries'

// A typeable country picker for the international collection points'
// ~70-country list -- scrolling a plain <select> that far is painful,
// especially on mobile, so this behaves like PlaceAutocomplete
// (components/PlaceAutocomplete.jsx) but is backed by the local
// countryOptions() list instead of a network call. The underlying value
// is always a real ISO code (or '' for "no country picked"): free text
// left in the field that doesn't match any option snaps back to the
// current selection on blur rather than staying as stray text.
//
// `allLabel`, when given (the list filter's "All countries" case),
// only adds a pickable "reset" entry to the suggestion list -- it never
// fills the field as literal text, even once picked, so the field stays
// genuinely empty and shows `placeholder` instead. That matches how the
// *required* create-form select already behaves (an empty field with a
// "-- select --" hint) instead of pre-filling real text the visitor
// would have to delete before typing.
export default function CountrySelect({ value, onChange, lang, placeholder, id, required, onInvalid, disabled, allLabel }) {
  const options = countryOptions(lang)
  const nameFor = (code) => (code ? options.find((c) => c.code === code)?.name || code : '')

  const [query, setQuery] = useState(nameFor(value))
  const [open, setOpen] = useState(false)
  const blurTimeoutRef = useRef(null)

  // Keeps the displayed text in sync with the actual selection (e.g. the
  // language switching mid-session, or a parent resetting the value).
  useEffect(() => {
    setQuery(nameFor(value))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, lang])

  useEffect(() => () => { if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current) }, [])

  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter((c) => c.name.toLowerCase().includes(q)) : options

  const pick = (code, name) => {
    onChange(code)
    setQuery(name)
    setOpen(false)
  }

  return (
    <div className="place-autocomplete">
      <input
        id={id}
        type="text"
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
          e.target.setCustomValidity('') // clears any translated required-field message set via onInvalid below
          if (e.target.value.trim() === '') onChange('')
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // A plain onClick on a suggestion would fire after this blur
          // (which already closed the list), so selection uses
          // onMouseDown instead -- this delay just gives that a moment
          // to land first, same pattern as PlaceAutocomplete.
          blurTimeoutRef.current = setTimeout(() => {
            setOpen(false)
            setQuery(nameFor(value))
          }, 150)
        }}
        placeholder={placeholder}
        required={required}
        onInvalid={onInvalid}
        autoComplete="off"
      />
      {open && (
        <ul className="place-suggestions" role="listbox">
          {allLabel && (
            <li role="option" onMouseDown={() => pick('', '')}>
              {allLabel}
            </li>
          )}
          {filtered.map((c) => (
            <li key={c.code} role="option" onMouseDown={() => pick(c.code, c.name)}>
              {c.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
