import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { countryFlagEmoji, CP_BOX_SVG_GREEN, CP_BOX_SVG_WHITE, CP_GREEN, routeToPoint } from '../mapMarkers'
import CountryOrPlaceSearch from '../components/CountryOrPlaceSearch'
import ExploreMap from '../components/ExploreMap'

// Worldwide counterpart to CollectionPoints.jsx (no wilaya, no Algeria
// restriction), in the same shared "explore" view. Points known only to a
// city or a country (flyer extraction) are grouped in one bubble per spot.
// The "city or country" field either filters by country or flies the map
// to a place. Never links to take-charge/Pickup (couriers only operate in
// Algeria, see CollectionPointDetail.jsx's cp.is_international guard).

export default function InternationalCollectionPoints() {
  const { t, i18n } = useTranslation()
  const location = useLocation()
  const [filterCountry, setFilterCountry] = useState('')
  const [countryLabel, setCountryLabel] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [pins, setPins] = useState([])
  const [loading, setLoading] = useState(true)
  const [fieldKey, setFieldKey] = useState(0)
  const mapRef = useRef(null)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ international: '1' })
    if (filterCountry) params.set('country', filterCountry)
    if (search) params.set('search', search)
    api(`/collection-points/locations/?${params}`)
      .then((data) => !cancelled && setPins(data || []))
      .catch(() => {}) // offline: the offline banner already says so
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [filterCountry, search, location.key])

  const items = useMemo(
    () =>
      pins
        .filter((p) => p.display_latitude != null && p.display_longitude != null)
        .map((p) => ({
          id: p.id,
          lat: p.display_latitude,
          lng: p.display_longitude,
          exact: p.has_exact_position,
          // Same spot (a city's or a country's centre) = same bubble.
          group: p.has_exact_position ? undefined : `${p.country_code}|${p.display_latitude.toFixed(3)},${p.display_longitude.toFixed(3)}`,
          raw: p,
        })),
    [pins]
  )

  const pin = useCallback(() => ({ html: CP_BOX_SVG_WHITE, color: CP_GREEN }), [])
  const card = useCallback(
    (x) => {
      const p = x.raw
      return {
        to: `/collection-points/${p.id}`,
        title: `${p.point_name} ${countryFlagEmoji(p.country_code)}`.trim(),
        subtitle: [p.organization || p.contact_name, p.city, p.country_name].filter(Boolean).join(' · '),
        text: p.hours || '',
        image: p.flyer_image,
        iconHtml: CP_BOX_SVG_GREEN,
        badges: [
          { text: t(`status.${p.status}`, p.status), tone: p.status === 'active' ? 'green' : 'grey' },
          ...(p.has_exact_position ? [] : [{ text: t('common.noExactGpsPosition'), tone: 'grey' }]),
        ],
      }
    },
    [t]
  )
  const bubble = useCallback(
    (members) => {
      const p = members[0].raw
      return {
        html: `<span class="xp-bubble" style="background:${CP_GREEN}">${CP_BOX_SVG_WHITE}<b>${members.length}</b></span>`,
        label: t('explore.approxBubble', { place: [p.city, p.country_name].filter(Boolean).join(', '), count: members.length }),
      }
    },
    [t]
  )

  const chips = [
    filterCountry && {
      key: 'country',
      label: `${countryFlagEmoji(filterCountry)} ${countryLabel || filterCountry}`,
      clear: () => {
        setFilterCountry('')
        setFieldKey((k) => k + 1)
      },
    },
    search && { key: 'search', label: `🔎 ${search}`, clear: () => setSearchInput('') },
  ].filter(Boolean)

  const filterPanel = (close) => (
    <>
      <CountryOrPlaceSearch
        key={fieldKey}
        lang={i18n.language}
        placeholder={t('internationalCollectionPoints.locationPlaceholder')}
        onSelectCountry={(code, label) => {
          setFilterCountry(code)
          setCountryLabel(typeof label === 'string' ? label : '')
        }}
        // A place (city, street...) flies the map there; it doesn't filter.
        onSelectPlace={({ lat, lon }) => {
          setFilterCountry('')
          mapRef.current?.setView([lat, lon], 12)
          close()
        }}
        excludeCountryCode="dz"
      />
      <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t('internationalCollectionPoints.searchPlaceholder')} aria-label={t('internationalCollectionPoints.searchPlaceholder')} />
      <Link to="/collection-points" className="sx-filters-link">🇩🇿 {t('internationalCollectionPoints.goToNationalLink')}</Link>
    </>
  )

  return (
    <ExploreMap
      items={items}
      loading={loading}
      pin={pin}
      card={card}
      bubble={bubble}
      clusterColor={CP_GREEN}
      countLabel={(n) => t('internationalCollectionPoints.inArea', { count: n })}
      emptyLabel={t('internationalCollectionPoints.noPointsYet')}
      addButton={{ to: '/international-collection-points/create', label: t('collectionPoints.addShort') }}
      filterPanel={filterPanel}
      filterCount={chips.length}
      chips={chips}
      fitKey={`${filterCountry}|${search}`}
      emptyView={[[35, 10], 3]}
      minZoom={2}
      onSelect={routeToPoint}
      onMapReady={(map) => {
        mapRef.current = map
      }}
      storageKey="internationalPointsView"
    />
  )
}
