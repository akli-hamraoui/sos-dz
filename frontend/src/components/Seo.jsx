import { Helmet } from 'react-helmet-async'
import { useLocation, matchPath } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

const SITE_URL = 'https://sosdz.org'
const OG_IMAGE = `${SITE_URL}/og-image.png`
const OG_LOCALE = { fr: 'fr_FR', ar: 'ar_DZ', en: 'en_US' }

// Maps each indexable route to its "seo.<key>" translation namespace (see
// locales/*.json) -- anything not listed here (create/detail/take-charge
// flows, etc.) falls back to "seo.default" rather than getting a fully
// bespoke title/description, since those pages aren't meant to be
// individually indexed or shared (see the sitemap, which only lists the
// routes below).
const SEO_ROUTES = [
  { path: '/', key: 'home' },
  { path: '/needs', key: 'needsList' },
  { path: '/help', key: 'help' },
  { path: '/collection-points', key: 'collectionPoints' },
  { path: '/international-collection-points', key: 'internationalCollectionPoints' },
  { path: '/deliveries', key: 'deliveries' },
  { path: '/about', key: 'about' },
  { path: '/legal', key: 'legal' },
]

export default function Seo() {
  const { pathname } = useLocation()
  const { t, i18n } = useTranslation()
  const matched = SEO_ROUTES.find((r) => matchPath({ path: r.path, end: true }, pathname))
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
            '@type': 'NGO',
            name: 'SOSDZ',
            url: SITE_URL,
            logo: `${SITE_URL}/logo-full.png`,
            description,
          })}
        </script>
      )}
    </Helmet>
  )
}
