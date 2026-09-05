// Runs after `vite build` (see package.json's "build" script). Bakes a
// distinct title/description/canonical/OG/Twitter block into a static
// dist/<route>/index.html for each of the routes below, so a crawler that
// never runs the app's JS (WhatsApp/Facebook/Twitter link previews, a
// non-JS Googlebot fallback fetch) still sees per-page values instead of
// just the homepage's -- the app itself also sets these client-side per
// route/language once it hydrates (see src/components/Seo.jsx), which is
// what a real browser uses, but that does nothing for a dumb crawler.
//
// Only the French copy is baked in here (fr.json) -- the app has no
// distinct URL per language (it switches client-side, via localStorage),
// so there is no separate crawlable URL to bake an English/Arabic variant
// into. French is what a fresh visitor with no stored preference actually
// gets, so it's the honest default for a static snapshot.
//
// No new dependency: this is plain string substitution against the exact
// `<!-- SEO:START --> ... <!-- SEO:END -->` block already in
// frontend/index.html (and therefore in the built dist/index.html too,
// since Vite copies static HTML through unchanged) -- deliberately not a
// real browser render (Playwright etc.), since every value used here is
// already known at build time from fr.json, not something that needs a
// live page load to compute.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SITE_URL = 'https://sosdz.org'
const OG_IMAGE = `${SITE_URL}/og-image.png`

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(scriptDir, '..')
const distDir = path.join(frontendDir, 'dist')
const shellPath = path.join(distDir, 'index.html')

const fr = JSON.parse(readFileSync(path.join(frontendDir, 'src/locales/fr.json'), 'utf8'))

// "/" is deliberately not listed here -- the built dist/index.html
// already carries the homepage's own block (that's what's hand-written in
// frontend/index.html), so there's nothing to regenerate for it.
const ROUTES = [
  { urlPath: '/needs', dir: 'needs', key: 'needsList' },
  { urlPath: '/help', dir: 'help', key: 'help' },
  { urlPath: '/collection-points', dir: 'collection-points', key: 'collectionPoints' },
  { urlPath: '/international-collection-points', dir: 'international-collection-points', key: 'internationalCollectionPoints' },
  { urlPath: '/deliveries', dir: 'deliveries', key: 'deliveries' },
  { urlPath: '/about', dir: 'about', key: 'about' },
  { urlPath: '/legal', dir: 'legal', key: 'legal' },
]

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function seoBlock({ title, description, canonicalUrl }) {
  const t = escapeHtml(title)
  const d = escapeHtml(description)
  return `<!-- SEO:START -->
    <title>${t}</title>
    <meta name="description" content="${d}" />
    <meta name="keywords" content="${escapeHtml(fr.seo.keywords)}" />
    <link rel="canonical" href="${canonicalUrl}" />
    <link rel="alternate" hreflang="x-default" href="${canonicalUrl}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="SOSDZ" />
    <meta property="og:title" content="${t}" />
    <meta property="og:description" content="${d}" />
    <meta property="og:url" content="${canonicalUrl}" />
    <meta property="og:image" content="${OG_IMAGE}" />
    <meta property="og:image:width" content="2172" />
    <meta property="og:image:height" content="1137" />
    <meta property="og:locale" content="fr_FR" />
    <meta property="og:locale:alternate" content="ar_DZ" />
    <meta property="og:locale:alternate" content="en_US" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${t}" />
    <meta name="twitter:description" content="${d}" />
    <meta name="twitter:image" content="${OG_IMAGE}" />
    <!-- SEO:END -->`
}

const shell = readFileSync(shellPath, 'utf8')
const seoBlockPattern = /<!-- SEO:START -->[\s\S]*?<!-- SEO:END -->/

if (!seoBlockPattern.test(shell)) {
  throw new Error(`Could not find the <!-- SEO:START -->...<!-- SEO:END --> block in ${shellPath}`)
}

let written = 0
for (const route of ROUTES) {
  const seo = fr.seo[route.key]
  const canonicalUrl = `${SITE_URL}${route.urlPath}`
  const html = shell.replace(seoBlockPattern, seoBlock({ title: seo.title, description: seo.description, canonicalUrl }))
  const outDir = path.join(distDir, route.dir)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'index.html'), html)
  written += 1
}

console.log(`generate-static-seo: wrote ${written} route(s) under ${path.relative(frontendDir, distDir)}/ (plus the homepage, already baked into index.html).`)
