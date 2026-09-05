// Runs after `vite build` (see package.json's "build" script). Two jobs,
// both driven by the same SEO_ROUTES list (src/seoRoutes.js) and the same
// fr.json copy the client-side <Seo> component uses, so there is exactly
// one place that knows "these are the site's indexable pages" and one
// place that knows what each one says:
//
// 1. Bakes a distinct title/description/canonical/OG/Twitter block into a
//    static dist/<route>/index.html per route, so a crawler that never
//    runs the app's JS (WhatsApp/Facebook/Twitter link previews, a non-JS
//    Googlebot fallback fetch) still sees per-page values instead of just
//    the homepage's -- the app itself also sets these client-side per
//    route/language once it hydrates (see src/components/Seo.jsx), which
//    is what a real browser uses, but that does nothing for a crawler.
// 2. (Re)generates dist/sitemap.xml from the same data, including the
//    Google image-sitemap extension (a caption/title per URL) and a
//    lastmod set to this actual build date -- richer, and always in sync
//    with the real page copy, unlike a hand-maintained static XML file
//    that silently goes stale the moment a description changes elsewhere.
//    There is deliberately no static frontend/public/sitemap.xml anymore;
//    this is the only place it's produced.
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
const BUILD_DATE = new Date().toISOString().slice(0, 10)

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(scriptDir, '..')
const distDir = path.join(frontendDir, 'dist')
const shellPath = path.join(distDir, 'index.html')

const fr = JSON.parse(readFileSync(path.join(frontendDir, 'src/locales/fr.json'), 'utf8'))

function escapeXml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function seoBlock({ title, description, canonicalUrl }) {
  const t = escapeXml(title)
  const d = escapeXml(description)
  return `<!-- SEO:START -->
    <title>${t}</title>
    <meta name="description" content="${d}" />
    <meta name="keywords" content="${escapeXml(fr.seo.keywords)}" />
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
      <image:title>${escapeXml(seo.title)}</image:title>
      <image:caption>${escapeXml(seo.description)}</image:caption>
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

if (!seoBlockPattern.test(shell)) {
  throw new Error(`Could not find the <!-- SEO:START -->...<!-- SEO:END --> block in ${shellPath}`)
}

// "/" is skipped here -- the built dist/index.html already carries the
// homepage's own block (that's what's hand-written in frontend/index.html).
let written = 0
for (const route of SEO_ROUTES.filter((r) => r.dir)) {
  const seo = fr.seo[route.key]
  const canonicalUrl = `${SITE_URL}${route.urlPath}`
  const html = shell.replace(seoBlockPattern, seoBlock({ title: seo.title, description: seo.description, canonicalUrl }))
  const outDir = path.join(distDir, route.dir)
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

console.log(`generate-static-seo: wrote ${written} route(s) under ${path.relative(frontendDir, distDir)}/ (plus the homepage, already baked into index.html) and regenerated sitemap.xml.`)
