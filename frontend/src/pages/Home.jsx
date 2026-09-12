import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { IconAlgeriaFlag, IconCamera, IconGlobeColor, IconHelp, IconMic, IconPlus } from '../icons'

export default function Home() {
  const { t } = useTranslation()
  const { config } = useApp()
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  // Only the wizard itself (UrgentSOS.jsx) knows for sure whether the voice
  // guide is configured -- it bounces back to "/" when disabled. Mirroring
  // that same check here just hides the entry point instead of sending
  // someone into a dead-end redirect.
  const voiceSosAvailable = config.voice_guide_available !== false

  useEffect(() => {
    if (!createMenuOpen) return
    const onDocClick = (event) => {
      if (!event.target.closest('.home-create-card')) setCreateMenuOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [createMenuOpen])

  return (
    <section className="home">
      <h1 className="sr-only">{t('seo.home.title')}</h1>
      <p className="home-tagline">{t('home.tagline')}</p>

      {/* The single red "Lancer un SOS" card used to cover both cases at
          once (a form-based need report and, buried three clicks away, the
          voice-guided /urgent-sos wizard). Splitting it into two
          always-visible halves surfaces the voice SOS directly from Home
          instead of leaving it unlinked, and lets each half carry its own
          urgency color instead of one red card for both. */}
      <div className="home-sos-card home-sos-split">
        <Link to="/create" className="home-sos-half home-sos-half-orange">
          <span className="home-sos-half-badge">{t('home.sosNonUrgentBadge')}</span>
          <span className="home-sos-icon icon-sos" aria-hidden="true" />
          <span className="home-sos-copy">
            <strong>{t('home.sosTitle')}</strong>
            <span>{t('home.sosDetail')}</span>
          </span>
        </Link>
        {voiceSosAvailable && (
          <Link to="/urgent-sos" className="home-sos-half home-sos-half-red">
            <span className="home-sos-half-badge">{t('home.sosUrgentBadge')}</span>
            <span className="home-sos-icon home-sos-icon-mic" aria-hidden="true">
              <IconMic width={26} height={26} />
            </span>
            <span className="home-sos-copy">
              <strong>{t('home.sosUrgentTitle')}</strong>
              <span>{t('home.sosUrgentSubtitle')}</span>
            </span>
          </Link>
        )}
      </div>

      <div className="home-collection-grid">
        <Link to="/collection-points" className="home-collection-card home-collection-card-algeria">
          <span className="home-card-icon"><IconAlgeriaFlag width={30} height={20} /></span>
          <strong>{t('home.collectionPointsAlgeria')}</strong>
          <span>{t('home.collectionPointsAlgeriaDescription')}</span>
          <em>{t('home.viewPoints')} <b aria-hidden="true">→</b></em>
        </Link>
        <Link to="/international-collection-points" className="home-collection-card home-collection-card-international">
          <span className="home-card-icon"><IconGlobeColor width={30} height={30} /></span>
          <strong>{t('home.collectionPointsInternational')}</strong>
          <span>{t('home.collectionPointsInternationalDescription')}</span>
          <em>{t('home.viewPoints')} <b aria-hidden="true">→</b></em>
        </Link>
      </div>

      {/* "Depuis un flyer" used to be a third option buried inside this
          menu -- a card you had to open before you could even see it. It
          now gets its own directly-tappable card next to "Créer un point
          de collecte", which keeps just the Algérie/international choice. */}
      <div className="home-secondary-grid">
        <div className="home-create-card">
          <button
            type="button"
            className="home-secondary-card home-secondary-card-create"
            aria-expanded={createMenuOpen}
            onClick={() => setCreateMenuOpen((open) => !open)}
          >
            <span className="home-secondary-icon"><IconPlus width={22} height={22} strokeWidth={2.5} /></span>
            <span className="home-secondary-copy">
              <strong>{t('home.createCollectionPoint')}</strong>
              <span>{t('home.createCollectionPointDescription')}</span>
              <em>{t('home.createPoint')} <b aria-hidden="true">→</b></em>
            </span>
          </button>
          {createMenuOpen && (
            <div className="home-btn-create-menu">
              <Link to="/collection-points/create" onClick={() => setCreateMenuOpen(false)}>
                <IconAlgeriaFlag width={18} height={18} /> {t('home.createCollectionPointAlgeria')}
              </Link>
              <Link to="/international-collection-points/create" onClick={() => setCreateMenuOpen(false)}>
                <IconGlobeColor width={18} height={18} /> {t('home.createCollectionPointInternational')}
              </Link>
            </div>
          )}
        </div>
        <Link to="/collection-points/submit-flyer" className="home-secondary-card home-secondary-card-flyer">
          <span className="home-secondary-icon"><IconCamera width={22} height={22} /></span>
          <span className="home-secondary-copy">
            <strong>{t('home.createCollectionPointFlyer')}</strong>
            <span>{t('home.createCollectionPointFlyerDescription')}</span>
            <em>{t('home.createPointFlyer')} <b aria-hidden="true">→</b></em>
          </span>
        </Link>
      </div>

      <Link to="/about" className="home-about-link">
        <IconHelp width={18} height={18} />
        <span>{t('nav.about')}</span>
        <b aria-hidden="true">→</b>
      </Link>
    </section>
  )
}
