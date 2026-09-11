import { useTranslation } from 'react-i18next'
import { IconClose } from '../icons'

// Full-screen photo viewer shared by every list row's PhotoThumb and every
// map popup's own "view photo" button -- closing it (backdrop click or the
// close button) only ever clears this overlay, never anything underneath
// it (the list stays exactly where it was, a map popup stays open).
export default function PhotoLightbox({ src, onClose }) {
  const { t } = useTranslation()
  if (!src) return null
  return (
    <div className="photo-lightbox" onClick={onClose} role="presentation">
      <button type="button" className="photo-lightbox-close" onClick={onClose} aria-label={t('common.close')}>
        <IconClose width={22} height={22} />
      </button>
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
    </div>
  )
}
