import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconAlgeriaFlag, IconGlobeColor, IconGlobe, IconMapPin, IconPlus, IconSosBubble, IconChevronRight } from '../icons'

// Card-based redesign per the "SOSDZ_Claude_Design_Pack" (design-system.md/
// colors.md/PROMPT_CLAUDE.md) and the reference mobile screenshot supplied
// alongside it -- rounded white/light-tinted cards (no thick black borders,
// generous spacing to avoid mis-taps) instead of the previous black-bordered
// square-grid pass, one clear action per card, SOS given the strongest
// visual weight and moved back to the top (per the pack's own ACCUEIL MOBILE
// ordering: header, intro, SOS, Algérie, étranger, créer, nav -- overriding
// this session's earlier "SOS last" request, since this new spec explicitly
// calls for SOS first and is what was asked to be implemented here).
export default function Home() {
  const { t } = useTranslation()
  const [createMenuOpen, setCreateMenuOpen] = useState(false)

  // Closes the Algérie/international choice menu on an outside click --
  // it isn't a native <select>/<details>, so nothing does this for free.
  // Same pattern as QuickActions' own delivery-destination menu (App.jsx).
  useEffect(() => {
    if (!createMenuOpen) return
    const onDocClick = (e) => {
      if (!e.target.closest('.home-btn-create')) setCreateMenuOpen(false)
    }
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  }, [createMenuOpen])

  return (
    <section className="home">
      {/* Visually hidden -- search engines and screen readers still need
          real text naming this page, even though the persistent header's
          own logo (App.jsx, "SOSDZ" + lockup) is what sighted visitors see;
          the pack's reference screenshot has no second, separate hero logo
          repeating that here. */}
      <h1 className="sr-only">{t('seo.home.title')}</h1>
      <span className="home-kicker">{t('home.kicker')}</span>
      <p className="home-tagline">{t('home.tagline')}</p>
      <div className="home-actions">
        {/* Biggest, reddest, first -- "priorité visuelle très claire" per
            the design pack, and the one card allowed a strong (not just
            light-tinted) color fill, since red is reserved for SOS/urgence
            everywhere else in the app too. */}
        <Link to="/create" className="home-card home-card-sos">
          <span className="home-card-icon">
            <IconSosBubble width={34} height={34} />
          </span>
          <span className="home-card-text">
            <span className="home-card-title">{t('home.iNeedHelp')}</span>
            <span className="home-card-subtitle">{t('home.iNeedHelpSubtitle')}</span>
          </span>
          <span className="home-card-arrow-badge">
            <IconChevronRight width={20} height={20} />
          </span>
        </Link>

        <Link to="/collection-points" className="home-card home-card-green">
          <span className="home-card-icon">
            <IconMapPin width={30} height={30} strokeWidth={2.2} />
          </span>
          <span className="home-card-text">
            <span className="home-card-title">{t('home.collectionPointsAlgeria')}</span>
            <span className="home-card-subtitle">{t('home.collectionPointsAlgeriaSubtitle')}</span>
          </span>
          <span className="home-card-arrow-badge">
            <IconChevronRight width={20} height={20} />
          </span>
        </Link>

        <Link to="/international-collection-points" className="home-card home-card-blue">
          <span className="home-card-icon">
            <IconGlobe width={30} height={30} strokeWidth={1.8} />
          </span>
          <span className="home-card-text">
            <span className="home-card-title">{t('home.collectionPointsInternational')}</span>
            <span className="home-card-subtitle">{t('home.collectionPointsInternationalSubtitle')}</span>
          </span>
          <span className="home-card-arrow-badge">
            <IconChevronRight width={20} height={20} />
          </span>
        </Link>

        {/* Creating a point is a distinct action from the two browse cards
            above, and needs a country choice first (this page has no
            wilaya/location context of its own to guess from) -- same small
            "open a menu on tap" pattern as QuickActions' own delivery-
            destination menu (App.jsx), not a route of its own. */}
        <div className="home-btn-create">
          <button
            type="button"
            className="home-card home-card-orange"
            aria-expanded={createMenuOpen}
            onClick={() => setCreateMenuOpen((v) => !v)}
          >
            <span className="home-card-icon">
              <IconPlus width={30} height={30} strokeWidth={2.2} />
            </span>
            <span className="home-card-text">
              <span className="home-card-title">{t('home.createCollectionPoint')}</span>
              <span className="home-card-subtitle">{t('home.createCollectionPointSubtitle')}</span>
            </span>
            <span className="home-card-arrow-badge">
              <IconChevronRight width={20} height={20} className={createMenuOpen ? 'home-card-arrow-open' : ''} />
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
      </div>
      {/* The guided voice SOS flow (CreateNeedVoiceGuide.jsx, /create-voice)
          deliberately has NO entry point here or anywhere else on the site,
          per explicit instruction -- reachable only via the direct URL
          (and gated Algeria-only/admin regardless, see AppConfigurationView/
          NeedViewSet.create_via_voice_guide, backend). */}
      {/* The footer also carries this link (it's the only entry point to
          /about from every other page), but there it sits far below the
          fold on Home specifically -- shown again here, right under the
          actions, so it's actually visible instead of buried at the very
          bottom of the screen. Hidden from the footer on this one route
          (see App.jsx) so it isn't shown twice. */}
      <Link to="/about" className="home-about-link">
        {t('nav.about')}
      </Link>
      {/* Real, visible descriptive text -- search engines (and AI
          summarizers, which read the same crawled HTML) can't read
          meaning from the icons above alone. A single, self-contained
          paragraph covering what SOSDZ is, the problem it solves, who
          it's for, and the three ways to use it -- exactly the kind of
          summary both classic search snippets and AI summaries tend to
          lift verbatim. */}
      <p className="home-description">{t('home.summary')}</p>
    </section>
  )
}
