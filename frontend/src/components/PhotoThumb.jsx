// Small clickable thumbnail (flyer/photo) shown in a list row -- opens the
// shared PhotoLightbox instead of navigating. A role="button" span, not a
// real <button>, since this needs to nest inside the row's own <Link>
// without invalid interactive-in-interactive HTML (same div-as-button
// pattern already used by the map's own .map-activate-overlay).
export default function PhotoThumb({ src, alt, onOpen }) {
  if (!src) return null
  return (
    <span
      className="photo-thumb"
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onOpen(src)
      }}
      aria-label={alt}
    >
      <img src={src} alt="" />
    </span>
  )
}
