// ISO 3166-1 alpha-2 codes for the international collection points country
// filter -- deliberately excludes "DZ" (Algeria): an international point is
// by definition never in Algeria, see InternationalCollectionPoints.jsx and
// the backend's own CollectionPointCreateSerializer.validate, which rejects
// "DZ" server-side too as a defense-in-depth backstop.
export const COUNTRY_CODES = [
  'FR', 'TN', 'MA', 'LY', 'EG', 'ES', 'IT', 'DE', 'BE', 'NL', 'GB', 'CH', 'PT', 'SE', 'NO', 'DK', 'FI', 'IE', 'AT', 'PL',
  'TR', 'SA', 'AE', 'QA', 'KW', 'BH', 'OM', 'JO', 'LB', 'IQ', 'SY', 'PS', 'YE', 'SD', 'MR', 'ML', 'NE', 'SN', 'CI', 'CM',
  'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE',
  'CN', 'JP', 'KR', 'IN', 'PK', 'ID', 'MY', 'SG', 'TH', 'VN', 'PH',
  'AU', 'NZ', 'ZA', 'NG', 'KE', 'GH',
  'RU', 'UA', 'RO', 'GR', 'CZ', 'HU', 'BG', 'HR', 'RS', 'AL',
]

// Hand-picked mainland/metropolitan bounding boxes (south, north, west,
// east) for the handful of COUNTRY_CODES entries whose full Nominatim/OSM
// administrative boundary bundles in far-flung overseas territories or
// exclaves -- e.g. "France" includes French Guiana (South America),
// Réunion (Indian Ocean) and French Polynesia (Pacific), so its real
// bounding box spans nearly the whole planet; Spain's includes the
// Canary Islands off the coast of Africa, widening it enough to also
// show most of Western Europe. utils.js's geocodeCountryBounds() uses
// this instead of a live geocode for exactly these codes -- every other
// country still gets its bounding box from Nominatim, which is accurate
// for a country with no such outlying territory (confirmed working for
// e.g. Spain's own mainland+Balearics extent below).
export const COUNTRY_MAINLAND_BOUNDS = {
  FR: { south: 41.3, north: 51.1, west: -5.2, east: 9.6 },
  ES: { south: 35.9, north: 43.9, west: -9.5, east: 4.4 },
  PT: { south: 36.8, north: 42.2, west: -9.6, east: -6.1 },
  NL: { south: 50.7, north: 53.6, west: 3.3, east: 7.3 },
  DK: { south: 54.5, north: 57.8, west: 8.0, east: 15.2 },
  NO: { south: 57.9, north: 71.2, west: 4.5, east: 31.3 },
  US: { south: 24.5, north: 49.4, west: -125.0, east: -66.9 },
  CL: { south: -56.0, north: -17.5, west: -75.7, east: -66.4 },
}

// Localized country names via the browser's own Intl.DisplayNames --
// avoids hand-maintaining ~70 country names x 3 languages, and covers
// fr/en/ar (and any future locale) for free. Falls back to the plain ISO
// code on the rare browser/locale combination without region-name data.
export function countryOptions(lang) {
  let displayNames
  try {
    displayNames = new Intl.DisplayNames([lang], { type: 'region' })
  } catch {
    displayNames = null
  }
  return COUNTRY_CODES.map((code) => ({
    code,
    name: displayNames ? displayNames.of(code) || code : code,
  })).sort((a, b) => a.name.localeCompare(b.name, lang))
}
