import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconNeeds } from '../icons'

function IconGroup(props) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="9" cy="8" r="3" />
      <circle cx="17" cy="9" r="2.4" />
      <path d="M3.5 19.5c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" />
      <path d="M15.5 14.6c2.3.3 4 2.2 4 4.9" />
    </svg>
  )
}

export default function Home() {
  const { t } = useTranslation()
  return (
    <section className="home">
      <img src="/logo-full.png" alt={t('common.brand')} className="home-logo" />
      <div className="home-actions">
        <Link to="/create" className="btn btn-huge btn-icon home-btn-primary">
          <IconGroup /> {t('home.iNeedHelp')}
        </Link>
        <Link to="/needs" className="btn btn-huge btn-icon home-btn-outline">
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
