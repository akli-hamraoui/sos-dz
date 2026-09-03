import { useState, useEffect } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from './context/AppContext'
import { setLanguage, getStoredLanguage } from './i18n'
import { getCsrfToken } from './api'
import { formatBadgeCount } from './utils'
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
import BackButton from './components/BackButton'
import { IconHome, IconNeeds, IconBox, IconTruck, IconPlus, IconWarning, IconWifiOff, IconCheckCircle, IconMenu, IconClose } from './icons'

// Small "this opens a map" cue on a bottom-nav icon -- Besoins/Points de
// collecte/Livraisons all default to their map view (see each page's own
// viewMode state), which isn't obvious from the plain list/box/truck icon
// alone. Not shown on Home (no map) or the two FABs (they create, not view).
// Filled red teardrop + white dot -- the familiar Google-Maps-style pin
// color, not the app's own monochrome icon set, precisely so this one
// glyph reads as "map" at a glance rather than blending into the rest of
// the (deliberately colorless) icon language.
function MapIndicator() {
  return (
    <span className="map-indicator" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 24 24">
        <path d="M12 21.5S5 14.8 5 9.8a7 7 0 1 1 14 0c0 5-7 11.7-7 11.7Z" fill="#EA4335" />
        <circle cx="12" cy="9.8" r="2.6" fill="#fff" />
      </svg>
    </span>
  )
}

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

// Maps a route to the translation key for a small, discreet page label
// shown above its content -- most useful on pages with no heading of
// their own (NeedsList, Deliveries). Detail pages that already show their
// own contextual title (a need's own title, a collection point's name)
// are deliberately left out, to avoid a redundant second label.
const PAGE_TITLE_KEYS = {
  '/': 'nav.home',
  '/needs': 'nav.needs',
  '/create': 'nav.iNeedHelp',
  '/collection-points': 'nav.collectionPoints',
  '/collection-points/create': 'collectionPoints.createTitle',
  '/deliveries': 'nav.deliveries',
  '/support': 'support.title',
  '/report-bug': 'reportBug.title',
  '/about': 'about.title',
  '/recover': 'recover.title',
}

function PageTitle() {
  const { t } = useTranslation()
  const location = useLocation()
  const key = PAGE_TITLE_KEYS[location.pathname]
  if (!key) return null
  return <p className="page-title">{t(key)}</p>
}

// Shared between the desktop and mobile topbar nav -- previously these
// links had no active-state styling at all (unlike BottomNav, which
// already highlighted the current tab), and "Signaler un bug" only
// existed in the footer. `isAdmin` adds a direct link to Django Admin
// itself, since being told "you're in admin mode" (the badge) without a
// way to reach the admin UI from the menu wasn't actually useful.
function TopNavLinks({ isActive, isAdmin }) {
  const { t } = useTranslation()
  return (
    <>
      <Link to="/needs" className={isActive('/needs') ? 'active' : ''}>
        {t('nav.needs')}
      </Link>
      <Link to="/collection-points" className={isActive('/collection-points') ? 'active' : ''}>
        {t('nav.collectionPoints')}
      </Link>
      <Link to="/deliveries" className={isActive('/deliveries') ? 'active' : ''}>
        {t('nav.deliveries')}
      </Link>
      <Link to="/create" className={isActive('/create') ? 'active' : ''}>
        {t('nav.iNeedHelp')}
      </Link>
      {/* Mirrors the Home page's two CTAs (J'ai besoin d'aide / Je veux
          aider) so the same pair of entry points is reachable from every
          page, not just the homepage -- same destination as "Besoins"
          above, just the "I want to help" framing for someone who doesn't
          think of it as browsing a list. */}
      <Link to="/needs" className={isActive('/needs') ? 'active' : ''}>
        {t('home.iWantToHelp')}
      </Link>
      <Link to="/support" className={isActive('/support') ? 'active' : ''}>
        {t('nav.forgotDetails')}
      </Link>
      <Link to="/report-bug" className={isActive('/report-bug') ? 'active' : ''}>
        {t('nav.reportBug')}
      </Link>
      {isAdmin && (
        <a href="/admin/" className="nav-admin-link">
          {t('nav.djangoAdmin')}
        </a>
      )}
      <LanguageSwitcher />
    </>
  )
}

function BottomNav() {
  const { t } = useTranslation()
  const location = useLocation()
  const { config } = useApp()
  const isActive = (path) => location.pathname === path
  return (
    <nav className="bottom-nav">
      <Link to="/" className={isActive('/') ? 'active' : ''}>
        <span className="icon"><IconHome /></span>
        <span>{t('nav.home')}</span>
      </Link>
      <Link to="/needs" className={isActive('/needs') ? 'active' : ''}>
        <span className="icon">
          <IconNeeds />
          <MapIndicator />
          {!!config.needs_open_count && <span className="nav-badge">{formatBadgeCount(config.needs_open_count)}</span>}
        </span>
        <span>{t('nav.needs')}</span>
      </Link>
      <div className="fab-group">
        <Link to="/create" className="fab-item" aria-label={t('nav.iNeedHelp')}>
          {/* "+" centered on top, a small type icon underneath it (same
              icon as the matching nav tab) -- both inside the circle, so
              the two FABs read as "add a need" / "add a collection point"
              rather than two identical plain "+" buttons. */}
          <span className="fab fab-need">
            <IconPlus width={16} height={16} strokeWidth={3} />
            {/* Same SOS mark used for need pins on the map (NeedsList.jsx),
                not the heart icon -- that's the icon the user already
                associates with "need" elsewhere in the app. */}
            <img src="/icons/need-marker-sos.png" width={15} height={15} alt="" style={{ filter: 'invert(1)' }} />
          </span>
          <span className="fab-label">{t('nav.fabNeed')}</span>
        </Link>
        <Link to="/collection-points/create" className="fab-item" aria-label={t('collectionPoints.addButton')}>
          <span className="fab fab-collection">
            <IconPlus width={16} height={16} strokeWidth={3} />
            <IconBox width={15} height={15} strokeWidth={2} />
          </span>
          <span className="fab-label">{t('nav.fabCollectionPoint')}</span>
        </Link>
      </div>
      <Link to="/collection-points" className={isActive('/collection-points') ? 'active' : ''}>
        <span className="icon">
          <IconBox />
          <MapIndicator />
          {!!config.collection_points_active_count && (
            <span className="nav-badge">{formatBadgeCount(config.collection_points_active_count)}</span>
          )}
        </span>
        {/* Shorter than nav.collectionPoints (used elsewhere: topbar link,
            the needs-map type filter) -- this tab is squeezed next to the
            new two-FAB group and "Points de collecte" no longer fits on
            one line at the same font-size. */}
        <span>{t('nav.collectionPointsShort')}</span>
      </Link>
      <Link to="/deliveries" className={isActive('/deliveries') ? 'active' : ''}>
        <span className="icon">
          <IconTruck />
          <MapIndicator />
          {!!config.deliveries_en_route_count && <span className="nav-badge">{formatBadgeCount(config.deliveries_en_route_count)}</span>}
        </span>
        <span>{t('nav.deliveries')}</span>
      </Link>
    </nav>
  )
}

export default function App() {
  const { t } = useTranslation()
  const { config, isOnline, syncMessage } = useApp()
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()
  const isActive = (path) => location.pathname === path

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
          <img src="/logo-lockup.png" alt={t('common.brand')} className="brand-logo" />
        </Link>
        {config.is_admin && (
          <span className="admin-badge">
            {t('common.adminModeBadge')}
            {' · '}
            {/* Django 5's admin logout only accepts POST (a plain GET link
                gets a 405), so this needs a real form + CSRF token rather
                than a plain <a href>. */}
            <form method="post" action="/admin/logout/?next=/" className="admin-badge-logout-form">
              <input type="hidden" name="csrfmiddlewaretoken" value={getCsrfToken() || ''} />
              <button type="submit" className="link admin-badge-logout">
                {t('common.adminLogout')}
              </button>
            </form>
          </span>
        )}
        <nav className="topbar-nav-desktop">
          <TopNavLinks isActive={isActive} isAdmin={config.is_admin} />
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
          <TopNavLinks isActive={isActive} isAdmin={config.is_admin} />
        </nav>
      )}

      <main>
        {location.pathname !== '/' && <BackButton />}
        <PageTitle />
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
          <Route path="/collection-points/:id/take-charge" element={<TakeCharge source="collection_point" />} />
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
        {/* "Coordonnées oubliées" and "Signaler un bug" already live in the
            main nav (TopNavLinks) -- repeating them here just duplicated
            the same link twice on one page. Only "Qui sommes-nous" has no
            other entry point -- except on Home itself, which shows its own
            copy right under the action buttons (far more visible there
            than this footer, which sits at the very bottom of the
            screen); skip it here on that one route to avoid a duplicate. */}
        {location.pathname !== '/' && (
          <p className="footer-links">
            <Link to="/about">{t('nav.about')}</Link>
          </p>
        )}
      </footer>

      <BottomNav />
    </>
  )
}
