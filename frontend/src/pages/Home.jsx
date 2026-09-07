import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconAlgeriaFlag, IconGlobeColor, IconHelp, IconPlus } from '../icons'

export default function Home() {
  const { t } = useTranslation()
  const [createMenuOpen, setCreateMenuOpen] = useState(false)

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
      <p className="home-mission">{t('home.mission')}</p>
      <p className="home-tagline">{t('home.tagline')}</p>

      <Link to="/create" className="home-sos-card">
        <span className="home-sos-icon icon-sos" aria-hidden="true" />
        <span className="home-sos-copy">
          <strong>{t('home.sosTitle')}</strong>
          <span>{t('home.sosSubtitle')}</span>
          <small>{t('home.sosDetail')}</small>
        </span>
        <span className="home-card-arrow" aria-hidden="true">›</span>
      </Link>

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

      <div className="home-create-card">
        <button
          type="button"
          className="home-create-trigger"
          aria-expanded={createMenuOpen}
          onClick={() => setCreateMenuOpen((open) => !open)}
        >
          <span className="home-card-icon"><IconPlus width={32} height={32} strokeWidth={2.5} /></span>
          <span className="home-create-copy">
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

      <Link to="/about" className="home-about-card">
        <span className="home-card-icon"><IconHelp width={32} height={32} /></span>
        <span className="home-about-copy">
          <strong>{t('nav.about')} ?</strong>
          <span>{t('home.summary')}</span>
          <em>{t('home.learnMore')} <b aria-hidden="true">→</b></em>
        </span>
      </Link>
    </section>
  )
}
