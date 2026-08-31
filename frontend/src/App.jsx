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
import CollectionPoints from './pages/CollectionPoints'
import CreateCollectionPoint from './pages/CreateCollectionPoint'
import CollectionPointDetail from './pages/CollectionPointDetail'

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
        <span className="icon">🏠</span>
        <span>{t('nav.home')}</span>
      </Link>
      <Link to="/needs" className={isActive('/needs') ? 'active' : ''}>
        <span className="icon">🗺️</span>
        <span>{t('nav.needs')}</span>
      </Link>
      <Link to="/create" aria-label={t('nav.iNeedHelp')}>
        <span className="fab">+</span>
      </Link>
      <Link to="/collection-points" className={isActive('/collection-points') ? 'active' : ''}>
        <span className="icon">📦</span>
        <span>{t('nav.collectionPoints')}</span>
      </Link>
      <Link to="/support" className={isActive('/support') ? 'active' : ''}>
        <span className="icon">❓</span>
        <span>{t('nav.support')}</span>
      </Link>
    </nav>
  )
}

export default function App() {
  const { t } = useTranslation()
  const { config, isOnline, syncMessage } = useApp()

  return (
    <>
      {config.mode === 'read_only' && <div className="readonly-banner">⚠️ {t('readOnly.banner')}</div>}
      {!isOnline && <div className="offline-banner">📴 {t('offline.youAreOffline')}</div>}
      {syncMessage && (
        <div className="offline-banner">
          ✅ {syncMessage === 'syncedOne' ? t('offline.syncedOne') : t('offline.syncedMany', { count: 1 })}
        </div>
      )}

      <header className="topbar">
        <Link to="/" className="brand">
          {t('common.brand')}
        </Link>
        <nav>
          <Link to="/needs">{t('nav.needs')}</Link>
          <Link to="/collection-points">{t('nav.collectionPoints')}</Link>
          <Link to="/create">{t('nav.iNeedHelp')}</Link>
          <Link to="/support">{t('nav.forgotDetails')}</Link>
          <LanguageSwitcher />
        </nav>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<CreateNeed />} />
          <Route path="/needs" element={<NeedsList />} />
          <Route path="/needs/:id" element={<NeedDetail />} />
          <Route path="/needs/:id/take-charge" element={<TakeCharge />} />
          <Route path="/recover" element={<Recover />} />
          <Route path="/support" element={<Support />} />
          <Route path="/collection-points" element={<CollectionPoints />} />
          <Route path="/collection-points/create" element={<CreateCollectionPoint />} />
          <Route path="/collection-points/:id" element={<CollectionPointDetail />} />
        </Routes>
      </main>

      <footer>
        <p>
          {t('common.adminContact')}: <a href="tel:+213000000000">+213 0 00 00 00 00</a> (phone/WhatsApp)
        </p>
      </footer>

      <BottomNav />
    </>
  )
}
