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
