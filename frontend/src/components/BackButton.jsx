import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconArrowLeft } from '../icons'

// In-app "back" button, independent of the browser's own back button (which
// stays fully functional -- this is an addition, not a replacement). Plain
// <BrowserRouter> gives every history entry a `key`, and the very first
// entry of a tab is always keyed 'default' -- so when there's nothing to
// go back to in-app (a deep link, a fresh reload, a new tab), `location.key
// === 'default'` tells us to fall back to a sensible route instead of
// calling navigate(-1) and leaving the app.
export default function BackButton({ fallback = '/', className = 'back-btn' }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()

  const goBack = () => {
    if (location.key !== 'default') {
      navigate(-1)
    } else {
      navigate(fallback)
    }
  }

  return (
    <button type="button" className={className} onClick={goBack} aria-label={t('common.back')}>
      <IconArrowLeft width={18} height={18} strokeWidth={2} />
      <span>{t('common.back')}</span>
    </button>
  )
}
