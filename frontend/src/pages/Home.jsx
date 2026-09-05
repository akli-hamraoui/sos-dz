import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { IconBox, IconGlobe } from '../icons'

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
        <Link to="/create" className="btn btn-huge btn-icon home-btn-primary">
          {/* Same SOS mark used for need pins/the footer FAB elsewhere in
              the app -- the icon the user already associates with "need".
              Masked (not a plain <img>) so it can be tinted an exact
              muted red via background-color, rather than the white the
              button used to show -- a filter-based tint (invert/hue-
              rotate) can't hit a precise, deliberately-desaturated color
              reliably. */}
          <span className="icon-sos-red" aria-hidden="true" />
          {t('home.iNeedHelp')}
        </Link>
        <Link to="/collection-points" className="btn btn-huge btn-icon home-btn-outline">
          <IconBox width={22} height={22} strokeWidth={1.75} /> {t('home.collectionPointsAlgeria')}
        </Link>
        <Link to="/international-collection-points" className="btn btn-huge btn-icon home-btn-outline">
          <IconGlobe width={22} height={22} strokeWidth={1.75} /> {t('home.collectionPointsInternational')}
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
