import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { IconClose } from '../icons'
import { useBackLayer } from '../backButton'

export default function PhotoLightbox({ src, onClose, images = [], index = 0, onNavigate }) {
  const { t } = useTranslation()
  useBackLayer(!!src, onClose)
  useEffect(() => {
    if (!src) return undefined
    const handleKey = (event) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowRight' && index < images.length - 1) onNavigate?.(index + 1)
      if (event.key === 'ArrowLeft' && index > 0) onNavigate?.(index - 1)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [src, index, images.length, onClose, onNavigate])
  if (!src) return null
  return (
    <div className="photo-lightbox" onClick={onClose} role="presentation">
      <button type="button" className="photo-lightbox-close" onClick={onClose} aria-label={t('common.close')}>
        <IconClose width={22} height={22} />
      </button>
      {images.length > 1 && index > 0 && <button type="button" className="photo-lightbox-nav photo-lightbox-prev" onClick={(e) => { e.stopPropagation(); onNavigate?.(index - 1) }} aria-label="Previous photo">‹</button>}
      <img src={src} alt="" onClick={(e) => e.stopPropagation()} />
      {images.length > 1 && index < images.length - 1 && <button type="button" className="photo-lightbox-nav photo-lightbox-next" onClick={(e) => { e.stopPropagation(); onNavigate?.(index + 1) }} aria-label="Next photo">›</button>}
      {images.length > 1 && <span className="photo-lightbox-count">{index + 1} / {images.length}</span>}
    </div>
  )
}
