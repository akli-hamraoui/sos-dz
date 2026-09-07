import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconAlgeriaFlag, IconGlobeColor, IconMapPin, IconPlus } from '../icons'

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
      {/* Visually hidden -- the logo image above already conveys this to
          sighted visitors, but search engines and screen readers need
          real text, not just an image, to know what this page is. */}
      <h1 className="sr-only">{t('seo.home.title')}</h1>
      <img src="/logo-full.png" alt={t('common.brand')} className="home-logo" />
      <p className="home-tagline">{t('home.tagline')}</p>
      <div className="home-actions">
        <Link to="/collection-points" className="btn btn-icon home-btn-outline home-btn-compact">
          <IconAlgeriaFlag /> {t('home.collectionPointsAlgeria')}
          {/* Small trailing cue that this leads to a map view (both
              collection-point pages default to their map -- see each
              page's own viewMode state), same IconMapPin glyph already
              used elsewhere in the app for this, just smaller than the
              flag/globe so it reads as a subordinate hint, not a second
              equally-weighted icon. */}
          <IconMapPin width={16} height={16} strokeWidth={1.75} className="home-btn-map-hint" />
        </Link>
        <Link to="/international-collection-points" className="btn btn-icon home-btn-outline home-btn-compact">
          <IconGlobeColor /> {t('home.collectionPointsInternational')}
          <IconMapPin width={16} height={16} strokeWidth={1.75} className="home-btn-map-hint" />
        </Link>
        {/* Creating a point is a distinct action from the two browse
            buttons above, and needs a country choice first (this page has
            no wilaya/location context of its own to guess from) -- same
            small "open a menu on tap" pattern as QuickActions' own
            delivery-destination menu (App.jsx), not a route of its own. */}
        <div className="home-btn-create">
          <button
            type="button"
            className="btn btn-icon home-btn-black home-btn-compact"
            aria-expanded={createMenuOpen}
            onClick={() => setCreateMenuOpen((v) => !v)}
          >
            <IconPlus width={20} height={20} strokeWidth={2} /> {t('home.createCollectionPoint')}
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
        {/* Last/bottom by design -- moved from first to last, and from
            black to red (not too dark), per explicit request. */}
        <Link to="/create" className="btn btn-huge btn-icon home-btn-sos">
          {/* Same SOS mark used for need pins/the footer FAB elsewhere in
              the app. Masked (not a plain <img>) so it can be tinted an
              exact color via background-color -- white here, for contrast
              against this button's own red background (it was a muted red
              on the previous black button; that same red would disappear
              against a red button, so it flipped to white instead). */}
          <span className="icon-sos" aria-hidden="true" />
          {t('home.iNeedHelp')}
        </Link>
      </div>
      {/* New, separate entry point for the tap-driven audio-narrated SOS
          flow (CreateNeedVoiceGuide.jsx) -- deliberately a small secondary
          link, not another full-size pill competing with "Lancer un SOS"
          above, since this is a pending-approval feature still being
          evaluated, not a replacement for the existing flow. */}
      <Link to="/create-voice" className="voice-guide-entry-link">
        🎙️ {t('voiceGuide.entryLinkLabel')}
      </Link>
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
          meaning from the icons/photo above alone. A single, self-
          contained paragraph covering what SOSDZ is, the problem it
          solves, who it's for, and the three ways to use it -- exactly
          the kind of summary both classic search snippets and AI
          summaries tend to lift verbatim. Sits below the fold content
          already on the page, so it doesn't affect the button positions
          above (tuned to stay visible on short/tablet viewports -- see
          index.css's .home rules). */}
      <p className="home-description">{t('home.summary')}</p>
    </section>
  )
}
