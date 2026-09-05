// Runs after `vite build` (see package.json's "build" script). Driven by
// the same SEO_ROUTES list (src/seoRoutes.js) and the same fr.json copy
// the client-side <Seo> component uses, so there is exactly one place
// that knows "these are the site's indexable pages" and one place that
// knows what each one says. Three jobs:
//
// 1. Bakes a distinct title/description/canonical/OG/Twitter block (and,
//    for the homepage, Organization + FAQPage JSON-LD) into a static
//    dist/<route>/index.html per route -- including the homepage itself,
//    dist/index.html -- so a crawler that never runs the app's JS
//    (WhatsApp/Facebook/Twitter link previews, a non-JS Googlebot
//    fallback fetch, or an AI crawler that doesn't execute JS at all)
//    still sees per-page values, not just a generic placeholder. The app
//    itself also sets these client-side per route/language once it
//    hydrates (see src/components/Seo.jsx), which is what a real browser
//    uses, but that does nothing for a crawler. Previously the homepage's
//    block was hand-written directly in frontend/index.html, kept in sync
//    with fr.json by hand -- that already drifted once (an old NGO type/
//    logo URL survived here after Seo.jsx was corrected). Generating it
//    here instead, from the same data, makes that kind of drift
//    impossible: frontend/index.html itself now only needs the
//    SEO:START/END markers and an empty <div id="root">, both replaced
//    unconditionally for every route including "/".
// 2. Injects real, visible body text (the homepage's summary paragraph +
//    FAQ) into the homepage's own dist/index.html, inside
//    <div id="root">. Without this, a crawler that doesn't run JS sees a
//    genuinely empty <body> on every page of this SPA -- confirmed by
//    building and inspecting dist/index.html directly. Safe to do this
//    only because main.jsx uses React's createRoot(...).render(), not
//    hydrateRoot(): createRoot takes full ownership of its container and
//    replaces all existing children the first time it renders, so this
//    static content is automatically wiped the instant the real app
//    mounts -- no manual cleanup script needed (unlike the <head> tags,
//    which needed one; see index.html's own cleanup <script>). This is
//    scoped to the homepage only, matching what was actually asked for --
//    the same gap exists on every other route too, and the mechanism
//    here would generalize cheaply, but doing that for the whole site
//    wasn't requested.
// 3. (Re)generates dist/sitemap.xml from the same data, including the
//    Google image-sitemap extension (a caption/title per URL) and a
//    lastmod set to this actual build date. There is deliberately no
//    static frontend/public/sitemap.xml anymore; this is the only place
//    it's produced.
//
// Only the French copy is baked in (fr.json) -- the app has no distinct
// URL per language (it switches client-side, via localStorage), so there
// is no separate crawlable URL to bake an English/Arabic variant into,
// and no per-language field in the sitemap protocol (or its image
// extension) to put one in either. French is what a fresh visitor with
// no stored preference actually gets, so it's the honest default for a
// static snapshot.
//
// No new dependency: this is plain string/template generation, not a
// real browser render (Playwright etc.) -- every value used here is
// already known at build time from fr.json, not something that needs a
// live page load to compute.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { SEO_ROUTES } from '../src/seoRoutes.js'

const SITE_URL = 'https://sosdz.org'
const OG_IMAGE = `${SITE_URL}/og-image.png`
const LOGO_IMAGE = `${SITE_URL}/logo.png`
const GITHUB_URL = 'https://github.com/akli-hamraoui/sos-dz'
const BUILD_DATE = new Date().toISOString().slice(0, 10)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(scriptDir, '..')
const distDir = path.join(frontendDir, 'dist')
const shellPath = path.join(distDir, 'index.html')

const fr = JSON.parse(readFileSync(path.join(frontendDir, 'src/locales/fr.json'), 'utf8'))

function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function organizationJsonLd() {
  // Plain Organization, not NGO/NonprofitOrganization: the About page
  // itself is explicit that SOSDZ "isn't affiliated with any
  // administration or official organization" -- it's a volunteer-run
  // community tool, not a registered nonprofit entity, so claiming NGO
  // status would misrepresent it (and risk a schema/visible-content
  // mismatch under Google's own structured-data policy). Keep in sync
  // with src/components/Seo.jsx's own copy of this object.
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'SOSDZ',
    url: SITE_URL,
    logo: LOGO_IMAGE,
    description: fr.seo.home.description,
    sameAs: [GITHUB_URL],
  }
}

function faqPageJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: fr.home.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  }
}

function seoBlock({ title, description, canonicalUrl, jsonLd }) {
  const t = escapeAttr(title)
  const d = escapeAttr(description)
  const jsonLdScripts = (jsonLd || []).map((obj) => `\n    <script type="application/ld+json">${JSON.stringify(obj)}</script>`).join('')
  return `<!-- SEO:START -->
    <title>${t}</title>
    <meta name="description" content="${d}" />
    <meta name="keywords" content="${escapeAttr(fr.seo.keywords)}" />
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
    <meta name="twitter:image" content="${OG_IMAGE}" />${jsonLdScripts}
    <!-- SEO:END -->`
}

function homeBodyHtml() {
  const { home } = fr
  const faqItems = home.faq
    .map(
      (item) => `      <h3>${escapeHtml(item.q)}</h3>
      <p>${escapeHtml(item.a)}</p>`
    )
    .join('\n')
  return `<div id="root"><main style="max-width:640px;margin:40px auto;padding:0 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;line-height:1.6;">
      <h1>${escapeHtml(fr.seo.home.title)}</h1>
      <p>${escapeHtml(home.summary)}</p>
      <h2>${escapeHtml(home.faqHeading)}</h2>
${faqItems}
    </main></div>`
}

function sitemapXml() {
  const urls = SEO_ROUTES.map((route) => {
    const seo = fr.seo[route.key]
    const loc = `${SITE_URL}${route.urlPath}`
    return `  <url>
    <loc>${loc}</loc>
    <lastmod>${BUILD_DATE}</lastmod>
    <changefreq>${route.changefreq}</changefreq>
    <priority>${route.priority}</priority>
    <image:image>
      <image:loc>${OG_IMAGE}</image:loc>
      <image:title>${escapeAttr(seo.title)}</image:title>
      <image:caption>${escapeAttr(seo.description)}</image:caption>
    </image:image>
  </url>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.join('\n')}
</urlset>
`
}

const shell = readFileSync(shellPath, 'utf8')
const seoBlockPattern = /<!-- SEO:START -->[\s\S]*?<!-- SEO:END -->/
const rootDivPattern = /<div id="root"><\/div>/

if (!seoBlockPattern.test(shell)) {
  throw new Error(`Could not find the <!-- SEO:START -->...<!-- SEO:END --> block in ${shellPath}`)
}
if (!rootDivPattern.test(shell)) {
  throw new Error(`Could not find the empty <div id="root"></div> in ${shellPath}`)
}

let written = 0
for (const route of SEO_ROUTES) {
  const seo = fr.seo[route.key]
  const canonicalUrl = `${SITE_URL}${route.urlPath}`
  const isHome = route.key === 'home'
  const jsonLd = isHome ? [organizationJsonLd(), faqPageJsonLd()] : []
  let html = shell.replace(seoBlockPattern, seoBlock({ title: seo.title, description: seo.description, canonicalUrl, jsonLd }))
  if (isHome) {
    html = html.replace(rootDivPattern, homeBodyHtml())
  }
  const outDir = path.join(distDir, route.dir) // route.dir === '' for "/" resolves back to distDir itself
  mkdirSync(outDir, { recursive: true })
  writeFileSync(path.join(outDir, 'index.html'), html)
  written += 1
}

// vite build already copied public/sitemap.xml (if one exists) through
// unchanged -- remove it first so a stale copy can never linger if this
// script fails before reaching the write below.
const sitemapPath = path.join(distDir, 'sitemap.xml')
rmSync(sitemapPath, { force: true })
writeFileSync(sitemapPath, sitemapXml())

console.log(`generate-static-seo: wrote ${written} route(s) (including the homepage) under ${path.relative(frontendDir, distDir)}/ and regenerated sitemap.xml.`)
