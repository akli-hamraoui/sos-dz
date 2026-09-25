import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { CP_BOX_SVG_GREEN, CP_BOX_SVG_WHITE, CP_GREEN, routeToPoint } from '../mapMarkers'
import WilayaCombobox from '../components/WilayaCombobox'
import ExploreMap from '../components/ExploreMap'

// Collection points in Algeria, in the shared "explore" view
// (components/ExploreMap.jsx: full-screen map, list sheet / carousel,
// clusters). Tapping a point also draws the road from the visitor's
// position to it (within 100 km, best-effort). Points with no precise
// address are grouped in one bubble per wilaya. Filters: text search and
// wilaya. The points abroad have their own page (InternationalCollectionPoints.jsx).

export default function CollectionPoints() {
  const { t } = useTranslation()
  const location = useLocation()
  const { wilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [pins, setPins] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    if (filterWilaya) params.set('wilaya', filterWilaya)
    if (search) params.set('search', search)
    const qs = params.toString() ? `?${params}` : ''
    api(`/collection-points/locations/${qs}`)
      .then((data) => !cancelled && setPins((data || []).filter((p) => !p.is_international)))
      .catch(() => {}) // offline: the offline banner already says so
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [filterWilaya, search, location.key])

  const items = useMemo(
    () =>
      pins
        .filter((p) => p.display_latitude != null && p.display_longitude != null)
        .map((p) => ({ id: p.id, lat: p.display_latitude, lng: p.display_longitude, exact: p.has_exact_position, group: p.has_exact_position ? undefined : `w${p.wilaya}`, raw: p })),
    [pins]
  )

  const pin = useCallback(() => ({ html: CP_BOX_SVG_WHITE, color: CP_GREEN }), [])
  const card = useCallback(
    (x) => {
      const p = x.raw
      return {
        to: `/collection-points/${p.id}`,
        title: p.point_name,
        subtitle: [p.organization || p.contact_name, p.city, p.wilaya_name].filter(Boolean).join(' · '),
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
    (members) => ({
      html: `<span class="xp-bubble" style="background:${CP_GREEN}">${CP_BOX_SVG_WHITE}<b>${members.length}</b></span>`,
      label: t('explore.approxBubble', { place: members[0].raw.wilaya_name, count: members.length }),
    }),
    [t]
  )

  const wilayaName = wilayas.find((w) => String(w.id) === String(filterWilaya))?.name
  const chips = [
    wilayaName && { key: 'wilaya', label: wilayaName, clear: () => setFilterWilaya('') },
    search && { key: 'search', label: `🔎 ${search}`, clear: () => setSearchInput('') },
  ].filter(Boolean)

  const filterPanel = () => (
    <>
      <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t('collectionPoints.searchPlaceholder')} aria-label={t('collectionPoints.searchPlaceholder')} />
      <WilayaCombobox wilayas={wilayas} value={filterWilaya} onChange={setFilterWilaya} placeholder={t('needsList.filterByWilaya')} emptyLabel={t('needsList.all')} />
      <Link to="/international-collection-points" className="sx-filters-link">🌍 {t('collectionPoints.viewInternationalOnMap')}</Link>
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
      countLabel={(n) => t('collectionPoints.inArea', { count: n })}
      emptyLabel={t('collectionPoints.noPointsYet')}
      addButton={{ to: '/collection-points/create', label: t('collectionPoints.addShort') }}
      filterPanel={filterPanel}
      filterCount={chips.length}
      chips={chips}
      fitKey={`${filterWilaya}|${search}`}
      emptyView={[[28, 2.6], 5]}
      onSelect={routeToPoint}
      storageKey="collectionPointsView"
    />
  )
}
