import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconAlgeriaFlag, IconGlobeColor, IconMapPin } from '../icons'

export default function Home() {
  const { t } = useTranslation()
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
      {/* FAQPage structured data (see Seo.jsx) must match visible page
          content -- Google's own structured-data policy requires this,
          and it's the honest thing to do regardless. This is that
          visible copy; Seo.jsx reads the exact same "home.faq"
          translation array so the two can never drift apart. */}
      <section className="home-faq" aria-labelledby="home-faq-heading">
        <h2 id="home-faq-heading" className="page-title">{t('home.faqHeading')}</h2>
        {t('home.faq', { returnObjects: true }).map((item) => (
          <div className="home-faq-item" key={item.q}>
            <h3>{item.q}</h3>
            <p>{item.a}</p>
          </div>
        ))}
      </section>
    </section>
  )
}
