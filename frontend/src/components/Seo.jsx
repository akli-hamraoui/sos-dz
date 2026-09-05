import { Helmet } from 'react-helmet-async'
import { useLocation, matchPath } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { SEO_ROUTES } from '../seoRoutes'

const SITE_URL = 'https://sosdz.org'
const OG_IMAGE = `${SITE_URL}/og-image.png`
const OG_LOCALE = { fr: 'fr_FR', ar: 'ar_DZ', en: 'en_US' }

export default function Seo() {
  const { pathname } = useLocation()
  const { t, i18n } = useTranslation()
  // Anything not in SEO_ROUTES (create/detail/take-charge flows, etc.)
  // falls back to "seo.default" rather than a fully bespoke title/
  // description, since those pages aren't meant to be individually
  // indexed or shared (see the generated sitemap, which only lists
  // SEO_ROUTES' own pages).
  const matched = SEO_ROUTES.find((r) => matchPath({ path: r.urlPath, end: true }, pathname))
  const base = `seo.${matched ? matched.key : 'default'}`
  const title = t(`${base}.title`)
  const description = t(`${base}.description`)
  const lang = i18n.language
  const canonicalUrl = `${SITE_URL}${pathname}`

  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <meta name="keywords" content={t('seo.keywords')} />
      <link rel="canonical" href={canonicalUrl} />
      {/* No fr/en/ar hreflang alternates: the app switches language
          client-side (localStorage) rather than via distinct URLs, so
          there is no separate crawlable URL per language for Google to
          point those alternates at yet -- pointing all three at this same
          URL would be misleading, not helpful. x-default alone is valid
          on its own and correctly marks this URL as the one to serve
          visitors whose language doesn't match a specific alternate
          (which, right now, is everyone). */}
      <link rel="alternate" hrefLang="x-default" href={canonicalUrl} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="SOSDZ" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonicalUrl} />
      <meta property="og:image" content={OG_IMAGE} />
      <meta property="og:image:width" content="2172" />
      <meta property="og:image:height" content="1137" />
      <meta property="og:locale" content={OG_LOCALE[lang] || 'fr_FR'} />
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={OG_IMAGE} />
      {matched?.key === 'home' && (
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            // Plain Organization, not NGO/NonprofitOrganization: the About
            // page itself is explicit that SOSDZ "isn't affiliated with
            // any administration or official organization" -- it's a
            // volunteer-run community tool, not a registered nonprofit
            // entity, so claiming NGO status would misrepresent it (and
            // risk a schema/visible-content mismatch under Google's own
            // structured-data policy).
            '@type': 'Organization',
            name: 'SOSDZ',
            url: SITE_URL,
            // Square icon-only mark, not the wide text lockup -- matches
            // Google's own Organization logo guidance (roughly square,
            // >=112x112; logo.png is 800x800).
            logo: `${SITE_URL}/logo.png`,
            description,
            // The only genuine public link the site itself already
            // surfaces (see Legal.jsx) -- not inventing social profiles
            // that don't exist.
            sameAs: ['https://github.com/akli-hamraoui/sos-dz'],
          })}
        </script>
      )}
      {matched?.key === 'home' && (
        <script type="application/ld+json">
          {JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'FAQPage',
            // Built from the exact same "home.faq" translations rendered
            // as visible text on the page itself (see Home.jsx) -- the
            // markup must match what a visitor actually sees, per
            // Google's structured-data policy. Note: Google retired FAQ
            // rich results from Search entirely as of May 2026 (this
            // markup no longer produces the old dropdown snippet for
            // anyone) -- this is included as a best-effort, no-guaranteed-
            // effect signal for AI systems that read structured data as a
            // clarity/trust signal, not for a search feature that still
            // exists.
            mainEntity: t('home.faq', { returnObjects: true }).map((item) => ({
              '@type': 'Question',
              name: item.q,
              acceptedAnswer: { '@type': 'Answer', text: item.a },
            })),
          })}
        </script>
      )}
    </Helmet>
  )
}
