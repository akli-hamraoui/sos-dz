import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconNeeds } from '../icons'

export default function Home() {
  const { t } = useTranslation()
  return (
    <section className="home">
      <img src="/logo-icon-wordmark.png" alt={t('common.brand')} className="home-logo" />
      <p className="home-tagline">{t('home.tagline')}</p>
      <div className="home-actions">
        <Link to="/create" className="btn btn-huge btn-icon home-btn-primary">
          {/* Same SOS mark used for need pins/the footer FAB elsewhere in
              the app -- the icon the user already associates with "need". */}
          <img src="/icons/need-marker-sos.png" width={22} height={22} alt="" style={{ filter: 'invert(1)', flexShrink: 0 }} />
          {t('home.iNeedHelp')}
        </Link>
        <Link to="/help" className="btn btn-huge btn-icon home-btn-outline">
          <IconNeeds width={22} height={22} strokeWidth={2} /> {t('home.iWantToHelp')}
        </Link>
      </div>
      {/* The footer also carries this link (it's the only entry point to
          /about from every other page), but there it sits far below the
          fold on Home specifically -- shown again here, right under the
          actions, so it's actually visible instead of buried at the very
          bottom of the screen. Hidden from the footer on this one route
          (see App.jsx) so it isn't shown twice. */}
      <Link to="/about" className="home-about-link">
        {t('nav.about')}
      </Link>
    </section>
  )
}
