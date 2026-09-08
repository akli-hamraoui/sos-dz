import { useState, useEffect } from 'react'
import { Navigate, Routes, Route, Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from './context/AppContext'
import { setLanguage, getStoredLanguage } from './i18n'
import { getCsrfToken } from './api'
import { formatBadgeCount } from './utils'
import Home from './pages/Home'
import Help from './pages/Help'
import CreateNeed from './pages/CreateNeed'
import UrgentSOS from './pages/UrgentSOS'
import NeedsList from './pages/NeedsList'
import NeedDetail from './pages/NeedDetail'
import TakeCharge from './pages/TakeCharge'
import PickupDetail from './pages/PickupDetail'
import Recover from './pages/Recover'
import Support from './pages/Support'
import ReportBug from './pages/ReportBug'
import About from './pages/About'
import Legal from './pages/Legal'
import CollectionPoints from './pages/CollectionPoints'
import CreateCollectionPoint from './pages/CreateCollectionPoint'
import CollectionPointDetail from './pages/CollectionPointDetail'
import InternationalCollectionPoints from './pages/InternationalCollectionPoints'
import CreateInternationalCollectionPoint from './pages/CreateInternationalCollectionPoint'
import Deliveries from './pages/Deliveries'
import BackButton from './components/BackButton'
import Seo from './components/Seo'
import {
  IconHome,
  IconBox,
  IconGlobe,
  IconTruck,
  IconWarning,
  IconWifiOff,
  IconCheckCircle,
  IconMenu,
  IconClose,
  IconAlgeriaFlag,
  IconGlobeColor,
  IconPlus,
} from './icons'

// Small "this opens a map" cue on a bottom-nav icon -- Besoins/Points de
// collecte/Livraisons all default to their map view (see each page's own
// viewMode state), which isn't obvious from the plain list/box/truck icon
// alone. Not shown on Home (no map) or the two FABs (they create, not view).
// Filled black teardrop + white dot -- the familiar map-pin silhouette,
// filled rather than the app's usual thin-stroke style, so this one
// glyph reads as "map" at a glance rather than blending into the rest of
// the (deliberately colorless) icon language.
function MapIndicator({ shiftRight }) {
  return (
    <span className={`map-indicator${shiftRight ? ' map-indicator-shift' : ''}`} aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 24 24">
        <path d="M12 21.5S5 14.8 5 9.8a7 7 0 1 1 14 0c0 5-7 11.7-7 11.7Z" fill="#000" />
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
  '/help': 'home.iWantToHelp',
  '/create': 'nav.iNeedHelp',
  '/urgent-sos': 'urgentSos.title',
  '/collection-points': 'nav.collectionPoints',
  '/collection-points/create': 'collectionPoints.createTitle',
  '/international-collection-points': 'internationalCollectionPoints.navButton',
  '/international-collection-points/create': 'internationalCollectionPoints.createTitle',
  '/deliveries': 'nav.deliveries',
  '/support': 'support.title',
  '/report-bug': 'reportBug.title',
  '/about': 'about.title',
  '/legal': 'legal.title',
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
      {/* Same two destinations as the header QuickActions pills, also
          reachable from the main menu itself (desktop inline nav, or the
          mobile hamburger list) for anyone browsing/tapping through it
          directly rather than using the always-visible pills. Short labels
          (same text as the pills), not the full "+ Ajouter..." sentence --
          that pushed the desktop nav's total width past 1280px and off the
          edge of the screen with nothing to wrap onto. */}
      <Link
        to="/collection-points/create"
        className={isActive('/collection-points/create') ? 'active' : ''}
        title={t('collectionPoints.addButton')}
      >
        {t('quickActions.national')}
      </Link>
      <Link
        to="/international-collection-points/create"
        className={isActive('/international-collection-points/create') ? 'active' : ''}
        title={t('internationalCollectionPoints.addButton')}
      >
        {t('quickActions.international')}
      </Link>
      <Link to="/deliveries" className={isActive('/deliveries') ? 'active' : ''}>
        {t('nav.deliveries')}
      </Link>
      <Link to="/create" className={isActive('/create') ? 'active' : ''}>
        {t('nav.iNeedHelp')}
      </Link>
      {/* Mirrors the Home page's two CTAs (J'ai besoin d'aide / Je veux
          aider) so the same pair of entry points is reachable from every
          page, not just the homepage. Its own route (/help, Help.jsx) --
          previously this pointed at /needs, same as "Besoins" above, which
          made both nav items light up together on that page since they
          shared one isActive() check. */}
      <Link to="/help" className={isActive('/help') ? 'active' : ''}>
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

// Always-visible header shortcuts to the app's own creation flows --
// previously each map page (CollectionPoints.jsx, InternationalCollection
// Points.jsx) carried its own "+ Ajouter..." button inside a filters row
// that could scroll out of view or end up collapsed behind a "Filtres"
// toggle; these live in the topbar itself instead, next to the language
// switcher/hamburger, reachable from anywhere in the app regardless of
// which page's own filters are open or closed.
function QuickActions() {
  const { t } = useTranslation()
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [deliverMenuOpen, setDeliverMenuOpen] = useState(false)

  // Closes the Algérie/international choice menu on an outside click --
  // same pattern as Home's own equivalent menu (Home.jsx).
  useEffect(() => {
    if (!createMenuOpen) return
    const onDocClick = (e) => {
      if (!e.target.closest('.quick-actions-create')) setCreateMenuOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [createMenuOpen])

  // Closes the delivery-destination menu on an outside click -- it isn't
  // a native <select>/<details>, so nothing does this for free.
  useEffect(() => {
    if (!deliverMenuOpen) return
    const onDocClick = (e) => {
      if (!e.target.closest('.quick-actions-deliver')) setDeliverMenuOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [deliverMenuOpen])

  return (
    <div className="quick-actions">
      {/* One "+ Collecte" pill instead of two separate Algérie/international
          ones -- on a narrow phone screen the two used to wrap onto a
          second row, pushing this whole bar (and everything below it) down.
          Same choice-menu pattern as the deliver pill below and Home's own
          "create a collection point" button. */}
      <div className="quick-actions-create">
        <button
          type="button"
          className="quick-actions-btn"
          title={t('collectionPoints.addButton') + ' / ' + t('internationalCollectionPoints.addButton')}
          aria-expanded={createMenuOpen}
          onClick={() => setCreateMenuOpen((v) => !v)}
        >
          <IconPlus width={16} height={16} strokeWidth={2} />
          <span>{t('quickActions.create')}</span>
        </button>
        {createMenuOpen && (
          <div className="quick-actions-menu">
            <Link to="/collection-points/create" onClick={() => setCreateMenuOpen(false)}>
              <IconAlgeriaFlag width={16} height={16} /> {t('home.createCollectionPointAlgeria')}
            </Link>
            <Link to="/international-collection-points/create" onClick={() => setCreateMenuOpen(false)}>
              <IconGlobeColor width={16} height={16} /> {t('home.createCollectionPointInternational')}
            </Link>
          </div>
        )}
      </div>
      <div className="quick-actions-deliver">
        <button
          type="button"
          className="quick-actions-btn"
          title={t('deliveries.deliverToNeed') + ' / ' + t('deliveries.deliverToCollectionPoint')}
          aria-expanded={deliverMenuOpen}
          onClick={() => setDeliverMenuOpen((v) => !v)}
        >
          <IconTruck width={16} height={16} strokeWidth={1.9} />
          <span>{t('quickActions.deliver')}</span>
        </button>
        {deliverMenuOpen && (
          <div className="quick-actions-menu">
            <Link to="/needs" onClick={() => setDeliverMenuOpen(false)}>
              {t('deliveries.deliverToNeed')}
            </Link>
            <Link to="/collection-points" onClick={() => setDeliverMenuOpen(false)}>
              {t('deliveries.deliverToCollectionPoint')}
            </Link>
          </div>
        )}
      </div>
    </div>
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
      <Link to="/needs" className={`nav-icon-only${isActive('/needs') ? ' active' : ''}`} aria-label={t('nav.needs')}>
        <span className="icon">
          {/* Same SOS mark used for need pins/the Home & Besoins "J'ai
              besoin d'aide" buttons elsewhere -- inverted to white only in
              the active state, where the pill background goes dark (the
              other tabs' stroke-based icons get that for free via
              currentColor; a raster image needs the filter toggled by hand).
              No text label below it (unlike the other tabs) -- the icon
              already spells out "SOS" on its own. */}
          <img src="/icons/need-marker-sos.png" width={22} height={22} alt="" style={isActive('/needs') ? { filter: 'invert(1)' } : undefined} />
          <MapIndicator />
          {!!config.needs_open_count && <span className="nav-badge">{formatBadgeCount(config.needs_open_count)}</span>}
        </span>
      </Link>
      <Link to="/collection-points" className={isActive('/collection-points') ? 'active' : ''}>
        <span className="icon">
          <IconBox />
          <MapIndicator shiftRight />
          {!!config.collection_points_active_count && (
            <span className="nav-badge">{formatBadgeCount(config.collection_points_active_count)}</span>
          )}
        </span>
        {/* Two explicit lines (not organic wrapping, which the rest of
            this bar deliberately avoids -- see the historical note on
            .bottom-nav a's own white-space: nowrap) so this tab and its
            international sibling below read as a clearly labeled pair
            rather than the cryptic single-word "Collectes" this used to
            say before that sibling existed. */}
        <span className="nav-label-offset nav-label-2line">
          {t('nav.collectionPointsLine1')}
          <br />
          {t('nav.collectionPointsLine2')}
        </span>
      </Link>
      <Link to="/international-collection-points" className={isActive('/international-collection-points') ? 'active' : ''}>
        <span className="icon">
          <IconGlobe />
          {!!config.international_collection_points_active_count && (
            <span className="nav-badge">{formatBadgeCount(config.international_collection_points_active_count)}</span>
          )}
        </span>
        <span className="nav-label-offset nav-label-2line">
          {t('nav.internationalCollectionPointsLine1')}
          <br />
          {t('nav.internationalCollectionPointsLine2')}
        </span>
      </Link>
      <Link to="/deliveries" className={isActive('/deliveries') ? 'active' : ''}>
        <span className="icon">
          <IconTruck />
          <MapIndicator shiftRight />
          {!!config.deliveries_en_route_count && <span className="nav-badge">{formatBadgeCount(config.deliveries_en_route_count)}</span>}
        </span>
        <span className="nav-label-offset">{t('nav.deliveriesShort')}</span>
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
    // Land on every new page at its own top -- react-router's client-side
    // navigation doesn't reset scroll like a real page load does, so
    // without this a page opened while scrolled down on the previous one
    // would render already scrolled to that same offset.
    window.scrollTo(0, 0)
  }, [location.pathname])

  // Stops the browser's own back/forward scroll-restoration from fighting
  // the reset above -- without this, navigating back could still jump to
  // whatever offset the browser remembered instead of staying at the top.
  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual'
  }, [])

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
        {/* Quick access on mobile, next to the hamburger button, so
            switching language doesn't require opening the full menu and
            scrolling to the bottom of it -- the desktop nav already shows
            LanguageSwitcher inline (via TopNavLinks) so this is hidden
            there to avoid a duplicate (see index.css .topbar-lang-quick).
            The dropdown also stays inside the mobile menu list itself
            (TopNavLinks, unchanged) for anyone who opens it that way. */}
        <span className="topbar-lang-quick">
          <LanguageSwitcher />
        </span>
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
      {/* A dedicated row below the main header, not squeezed inline into it --
          the topbar's own content (nav links, or brand+lang+hamburger on
          mobile) already fills its width, leaving no reliable room for 3 more
          icon+text pills at any breakpoint. */}
      {location.pathname !== '/' && (
        <div className="quick-actions-bar">
          <QuickActions />
        </div>
      )}
      {navOpen && (
        <nav className="topbar-nav-mobile">
          <TopNavLinks isActive={isActive} isAdmin={config.is_admin} />
        </nav>
      )}

      <main>
        <Seo />
        {location.pathname !== '/' && <BackButton />}
        <PageTitle />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/create" element={<CreateNeed />} />
          <Route path="/urgent-sos" element={<UrgentSOS />} />
          <Route path="/create-voice" element={<Navigate to="/urgent-sos" replace />} />
          <Route path="/needs" element={<NeedsList />} />
          <Route path="/help" element={<Help />} />
          <Route path="/needs/:id" element={<NeedDetail />} />
          <Route path="/pickups/:id" element={<PickupDetail />} />
          <Route path="/needs/:id/take-charge" element={<TakeCharge />} />
          <Route path="/recover" element={<Recover />} />
          <Route path="/support" element={<Support />} />
          <Route path="/report-bug" element={<ReportBug />} />
          <Route path="/about" element={<About />} />
          <Route path="/legal" element={<Legal />} />
          <Route path="/collection-points" element={<CollectionPoints />} />
          <Route path="/collection-points/create" element={<CreateCollectionPoint />} />
          <Route path="/collection-points/:id" element={<CollectionPointDetail />} />
          <Route path="/collection-points/:id/take-charge" element={<TakeCharge source="collection_point" />} />
          <Route path="/international-collection-points" element={<InternationalCollectionPoints />} />
          <Route path="/international-collection-points/create" element={<CreateInternationalCollectionPoint />} />
          <Route path="/deliveries" element={<Deliveries />} />
        </Routes>
      </main>

      <footer>
        <p className="footer-disclaimer">{t('common.nonOfficialFooterNote')}</p>
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
        <p className="footer-links">
          {location.pathname !== '/' && (
            <>
              <Link to="/about">{t('nav.about')}</Link>{' · '}
            </>
          )}
          <Link to="/legal">{t('nav.legal')}</Link>
        </p>
      </footer>

      <BottomNav />
    </>
  )
}
