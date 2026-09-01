import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from './context/AppContext'
import { setLanguage, getStoredLanguage } from './i18n'
import Home from './pages/Home'
import CreateNeed from './pages/CreateNeed'
import NeedsList from './pages/NeedsList'
import NeedDetail from './pages/NeedDetail'
import TakeCharge from './pages/TakeCharge'
import Recover from './pages/Recover'
import Support from './pages/Support'
import ReportBug from './pages/ReportBug'
import About from './pages/About'
import CollectionPoints from './pages/CollectionPoints'
import CreateCollectionPoint from './pages/CreateCollectionPoint'
import CollectionPointDetail from './pages/CollectionPointDetail'
import Deliveries from './pages/Deliveries'
import { IconHome, IconNeeds, IconBox, IconHelp, IconPlus, IconWarning, IconWifiOff, IconCheckCircle, IconMenu, IconClose } from './icons'

function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  return (
    <span className="lang-switcher">
      <select
        aria-label={t('language.label')}
        value={getStoredLanguage()}
        onChange={(e) => setLanguage(e.target.value)}
      >
        <option value="fr">{t('language.fr')}</option>
        <option value="ar">{t('language.ar')}</option>
        <option value="en">{t('language.en')}</option>
      </select>
    </span>
  )
}

function BottomNav() {
  const { t } = useTranslation()
  const location = useLocation()
  const isActive = (path) => location.pathname === path
  return (
    <nav className="bottom-nav">
      <Link to="/" className={isActive('/') ? 'active' : ''}>
        <span className="icon"><IconHome /></span>
        <span>{t('nav.home')}</span>
      </Link>
      <Link to="/needs" className={isActive('/needs') ? 'active' : ''}>
        <span className="icon"><IconNeeds /></span>
        <span>{t('nav.needs')}</span>
      </Link>
      <Link to="/create" className="fab" aria-label={t('nav.iNeedHelp')}>
        <IconPlus width={26} height={26} strokeWidth={2} />
      </Link>
      <Link to="/collection-points" className={isActive('/collection-points') ? 'active' : ''}>
        <span className="icon"><IconBox /></span>
        <span>{t('nav.collectionPoints')}</span>
      </Link>
      <Link to="/support" className={isActive('/support') ? 'active' : ''}>
        <span className="icon"><IconHelp /></span>
        <span>{t('nav.support')}</span>
      </Link>
    </nav>
  )
}

export default function App() {
  const { t } = useTranslation()
  const { config, isOnline, syncMessage } = useApp()
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()

  useEffect(() => {
    setNavOpen(false) // close the mobile menu on every navigation
  }, [location.pathname])

  return (
    <>
      {config.mode === 'read_only' && (
        <div className="readonly-banner">
          <IconWarning width={17} height={17} /> {t('readOnly.banner')}
        </div>
      )}
      {!isOnline && (
        <div className="offline-banner">
          <IconWifiOff width={17} height={17} /> {t('offline.youAreOffline')}
        </div>
      )}
      {syncMessage && (
        <div className="offline-banner">
          <IconCheckCircle width={17} height={17} /> {syncMessage === 'syncedOne' ? t('offline.syncedOne') : t('offline.syncedMany', { count: 1 })}
        </div>
      )}

      <header className="topbar">
        <Link to="/" className="brand">
          {t('common.brand')}
        </Link>
        <nav className="topbar-nav-desktop">
          <Link to="/needs">{t('nav.needs')}</Link>
          <Link to="/collection-points">{t('nav.collectionPoints')}</Link>
          <Link to="/deliveries">{t('nav.deliveries')}</Link>
          <Link to="/create">{t('nav.iNeedHelp')}</Link>
          <Link to="/support">{t('nav.forgotDetails')}</Link>
          <LanguageSwitcher />
        </nav>
        <button
          type="button"
          className="nav-toggle"
          aria-label={t('nav.menu')}
          aria-expanded={navOpen}
          onClick={() => setNavOpen((v) => !v)}
        >
          {navOpen ? <IconClose /> : <IconMenu />}
        </button>
      </header>
      {navOpen && (
        <nav className="topbar-nav-mobile">
          <Link to="/needs">{t('nav.needs')}</Link>
          <Link to="/collection-points">{t('nav.collectionPoints')}</Link>
          <Link to="/deliveries">{t('nav.deliveries')}</Link>
          <Link to="/create">{t('nav.iNeedHelp')}</Link>
          <Link to="/support">{t('nav.forgotDetails')}</Link>
          <LanguageSwitcher />
        </nav>
      )}

      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<CreateNeed />} />
          <Route path="/needs" element={<NeedsList />} />
          <Route path="/needs/:id" element={<NeedDetail />} />
          <Route path="/needs/:id/take-charge" element={<TakeCharge />} />
          <Route path="/recover" element={<Recover />} />
          <Route path="/support" element={<Support />} />
          <Route path="/report-bug" element={<ReportBug />} />
          <Route path="/about" element={<About />} />
          <Route path="/collection-points" element={<CollectionPoints />} />
          <Route path="/collection-points/create" element={<CreateCollectionPoint />} />
          <Route path="/collection-points/:id" element={<CollectionPointDetail />} />
          <Route path="/deliveries" element={<Deliveries />} />
        </Routes>
      </main>

      <footer>
        {(config.contact_phones.length > 0 || config.admin_contact_email) && (
          <p>
            {t('common.adminContact')}:{' '}
            {config.contact_phones.map((p, i) => (
              <span key={i}>
                {i > 0 && ' — '}
                <a href={`tel:${p.phone}`}>
                  {p.phone}
                  {p.label ? ` (${p.label})` : ''}
                </a>
              </span>
            ))}
            {config.contact_phones.length > 0 && config.admin_contact_email && ' — '}
            {config.admin_contact_email && <a href={`mailto:${config.admin_contact_email}`}>{config.admin_contact_email}</a>}
          </p>
        )}
        <p className="footer-links">
          <Link to="/support">{t('nav.forgotDetails')}</Link>
          {' · '}
          <Link to="/report-bug">{t('nav.reportBug')}</Link>
          {' · '}
          <Link to="/about">{t('nav.about')}</Link>
        </p>
      </footer>

      <BottomNav />
    </>
  )
}
