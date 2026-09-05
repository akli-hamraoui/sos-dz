// Single source of truth for which routes get full SEO treatment: a
// distinct "seo.<key>" title/description in the locale files, an entry in
// the generated sitemap, and (for everything but "/") their own static
// prerendered dist/<dir>/index.html. Shared between the client-side
// <Seo> component (components/Seo.jsx) and the build-time script
// (scripts/generate-static-seo.mjs) so the two lists can't drift apart --
// add a new indexable page here once, not in two places.
//
// changefreq/priority follow the sitemap protocol
// (https://www.sitemaps.org/protocol.html): needs is the one thing that
// genuinely changes throughout the day, so it alone gets "daily"/highest
// priority among the list/section pages; about/legal are the most static.
export const SEO_ROUTES = [
  { urlPath: '/', dir: '', key: 'home', changefreq: 'weekly', priority: '1.0' },
  { urlPath: '/needs', dir: 'needs', key: 'needsList', changefreq: 'daily', priority: '0.9' },
  { urlPath: '/help', dir: 'help', key: 'help', changefreq: 'weekly', priority: '0.8' },
  { urlPath: '/collection-points', dir: 'collection-points', key: 'collectionPoints', changefreq: 'daily', priority: '0.8' },
  { urlPath: '/international-collection-points', dir: 'international-collection-points', key: 'internationalCollectionPoints', changefreq: 'weekly', priority: '0.6' },
  { urlPath: '/deliveries', dir: 'deliveries', key: 'deliveries', changefreq: 'weekly', priority: '0.6' },
  { urlPath: '/about', dir: 'about', key: 'about', changefreq: 'monthly', priority: '0.5' },
  { urlPath: '/legal', dir: 'legal', key: 'legal', changefreq: 'monthly', priority: '0.3' },
]
