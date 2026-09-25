import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import '../urgent-sos-wizard-fixes.css'

// Searchable wilaya picker -- same look and behaviour as the urgent SOS
// one (UrgentSOS.jsx: type to filter, chevron, clear button), but over
// all 58 wilayas (never only a campaign's). Matches the name or the code,
// ignoring accents and case ("bejaia" finds Béjaïa, "15" finds Tizi Ouzou).
const fold = (v) => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase()

function Chevron() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function WilayaCombobox({ id, wilayas, value, onChange, placeholder, emptyLabel }) {
  const { t } = useTranslation()
  const selected = wilayas.find((w) => String(w.id) === String(value))
  const label = (w) => `${w.code} - ${w.name}`
  const [search, setSearch] = useState(selected ? label(selected) : '')
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  // Follows a value set from outside (GPS / map pin -> nearest wilaya).
  useEffect(() => {
    setSearch(selected ? label(selected) : '')
  }, [selected])

  useEffect(() => {
    if (!open) return
    const outside = (e) => {
      if (!rootRef.current?.contains(e.target)) {
        setOpen(false)
        setSearch(selected ? label(selected) : '')
      }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, selected])

  const q = fold(search.trim())
  const showAll = !q || (selected && search === label(selected))
  const list = showAll ? wilayas : wilayas.filter((w) => fold(w.name).includes(q) || w.code.startsWith(q) || fold(label(w)).includes(q))

  const pick = (w) => {
    onChange(w ? String(w.id) : '')
    setSearch(w ? label(w) : '')
    setOpen(false)
  }

  // On phones the keyboard takes the bottom half of the screen: bring the
  // field to the top so the list opens above the keyboard, not under it.
  const openList = () => {
    setOpen(true)
    setTimeout(() => rootRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 250)
  }
  // Keeps the focus in the field when a button of the combobox is pressed:
  // otherwise the keyboard closes mid-tap, the page jumps and the tap can
  // land next to the option (seen on iPhone).
  const keepFocus = (e) => e.preventDefault()

  return (
    <div className="urgent-sos-wilaya-combobox signali-wilaya-combobox" ref={rootRef}>
      <input
        id={id}
        type="search"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          setOpen(true)
        }}
        onFocus={(e) => {
          openList()
          e.target.select()
        }}
        // Already focused (e.g. right after a pick): focus doesn't fire
        // again, the tap itself must reopen the list.
        onClick={() => !open && openList()}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
      />
      {(search || value) && (
        <button type="button" className="urgent-sos-wilaya-reset" onMouseDown={keepFocus} onClick={() => pick(null)} aria-label={t('common.close')}>
          ×
        </button>
      )}
      <button type="button" className="urgent-sos-wilaya-chevron" onMouseDown={keepFocus} onClick={() => (open ? setOpen(false) : openList())} aria-label={placeholder}>
        <Chevron />
      </button>
      {open && (
        <div className="urgent-sos-wilaya-options" role="listbox">
          {emptyLabel && (
            <button type="button" className="urgent-sos-wilaya-option" onMouseDown={keepFocus} onClick={() => pick(null)}>
              <span>{emptyLabel}</span>
            </button>
          )}
          {list.length ? (
            list.map((w) => (
              <button
                key={w.id}
                type="button"
                role="option"
                aria-selected={String(w.id) === String(value)}
                className="urgent-sos-wilaya-option"
                onMouseDown={keepFocus}
                onClick={() => pick(w)}
              >
                <span>{label(w)}</span>
              </button>
            ))
          ) : (
            <div className="urgent-sos-wilaya-empty">{wilayas.length ? t('signali.wilayaNoMatch') : t('common.loading')}</div>
          )}
        </div>
      )}
    </div>
  )
}
