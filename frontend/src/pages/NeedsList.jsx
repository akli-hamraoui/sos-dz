import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { urgencyColor } from '../utils'
import { NEED_SOS_ICON } from '../mapMarkers'
import WilayaCombobox from '../components/WilayaCombobox'
import ExploreMap from '../components/ExploreMap'

// The SOS/Besoins map, in the shared "explore" view (components/ExploreMap.jsx:
// full-screen map, list sheet / carousel, clusters): one pin per need,
// colored by urgency (critical ones pulse). Needs with no exact GPS are
// grouped in one bubble per wilaya (on its centre); needs reported with no
// location at all in one "no location" bubble on Alger. Filters: text
// search and wilaya (the active campaigns' ones).

const SOS_ICON_DARK = '<img src="/icons/need-marker-sos.png" width="30" height="30" alt="" />'
const URGENCY_TONE = { critical: 'red', high: 'orange', medium: 'grey', low: 'grey' }

export default function NeedsList() {
  const { t } = useTranslation()
  const location = useLocation()
  const { activeCampaignWilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [pins, setPins] = useState([])
  const [loading, setLoading] = useState(true)

  // Debounced so typing doesn't fire a request on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Re-queried on every visit (location.key): a need cancelled from its
  // own page must not stay on the map.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams()
    if (filterWilaya) params.set('wilaya', filterWilaya)
    if (search) params.set('search', search)
    const qs = params.toString() ? `?${params}` : ''
    api(`/needs/locations/${qs}`)
      .then((data) => !cancelled && setPins(data || []))
      .catch(() => {}) // offline: the offline banner already says so
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [filterWilaya, search, location.key])

  const alger = activeCampaignWilayas.find((w) => w.name === 'Alger')
  const items = useMemo(
    () =>
      pins
        .filter((p) => p.display_latitude != null && p.display_longitude != null)
        .map((p) => {
          // No location at all: one bubble on Alger (see NeedCreateSerializer's
          // own Alger-first fallback), not wherever the first one landed.
          if (p.has_no_location)
            return { id: p.id, lat: alger?.centroid_latitude ?? p.display_latitude, lng: alger?.centroid_longitude ?? p.display_longitude, exact: false, group: 'noloc', raw: p }
          return { id: p.id, lat: p.display_latitude, lng: p.display_longitude, exact: p.has_exact_position, group: p.has_exact_position ? undefined : `w${p.wilaya}`, raw: p }
        }),
    [pins, alger]
  )

  const pin = useCallback((x) => ({ html: NEED_SOS_ICON, color: urgencyColor(x.raw.urgency), blink: x.raw.urgency === 'critical' }), [])
  const card = useCallback(
    (x) => {
      const p = x.raw
      const covered = p.overall_status === 'covered'
      return {
        to: `/needs/${p.id}`,
        title: p.title || t('needsList.noGeographicPosition'),
        subtitle: [p.location_description, p.wilaya_name].filter(Boolean).join(' · '),
        image: p.photo,
        iconHtml: SOS_ICON_DARK,
        badges: [
          ...(p.urgency && p.urgency !== 'medium' ? [{ text: t(`urgency.${p.urgency}`, p.urgency), tone: URGENCY_TONE[p.urgency] || 'grey' }] : []),
          { text: t(`status.${p.overall_status}`, p.overall_status), tone: covered ? 'green' : 'blue' },
          ...(p.has_exact_position ? [] : [{ text: t('common.noExactGpsPosition'), tone: 'grey' }]),
        ],
      }
    },
    [t]
  )
  const bubble = useCallback(
    (members) => {
      const critical = members.some((m) => m.raw.urgency === 'critical')
      const noLocation = members[0].group === 'noloc'
      return {
        html: `<span class="xp-bubble${critical ? ' is-critical' : ''}" style="background:${critical ? '#d9273f' : '#e8590c'}">${NEED_SOS_ICON}<b>${members.length}</b></span>`,
        label: noLocation ? t('needsList.noLocationBubbleLabel') : t('explore.approxBubble', { place: members[0].raw.wilaya_name, count: members.length }),
      }
    },
    [t]
  )
  // Nothing to frame: the active campaign's wilayas (the affected zones).
  const fit = useCallback(
    (map, points, pad) => {
      if (points.length) return map.fitBounds(L.latLngBounds(points).pad(0.2), { maxZoom: filterWilaya ? 12 : 11, ...pad })
      const selected = activeCampaignWilayas.find((w) => String(w.id) === String(filterWilaya))
      if (selected?.centroid_latitude != null) return map.setView([selected.centroid_latitude, selected.centroid_longitude], 10)
      const centroids = activeCampaignWilayas.filter((w) => w.centroid_latitude != null).map((w) => [w.centroid_latitude, w.centroid_longitude])
      if (centroids.length) map.fitBounds(L.latLngBounds(centroids).pad(0.2), { maxZoom: 8, ...pad })
      else map.setView([28, 2.6], 5)
    },
    [activeCampaignWilayas, filterWilaya]
  )

  const wilayaName = activeCampaignWilayas.find((w) => String(w.id) === String(filterWilaya))?.name
  const chips = [
    wilayaName && { key: 'wilaya', label: wilayaName, clear: () => setFilterWilaya('') },
    search && { key: 'search', label: `🔎 ${search}`, clear: () => setSearchInput('') },
  ].filter(Boolean)

  const filterPanel = () => (
    <>
      <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t('needsList.searchPlaceholder')} aria-label={t('needsList.searchPlaceholder')} />
      <WilayaCombobox wilayas={activeCampaignWilayas} value={filterWilaya} onChange={setFilterWilaya} placeholder={t('needsList.filterByWilaya')} emptyLabel={t('needsList.all')} />
    </>
  )

  return (
    <ExploreMap
      items={items}
      loading={loading}
      pin={pin}
      card={card}
      bubble={bubble}
      clusterColor="#e8590c"
      countLabel={(n) => t('needsList.inArea', { count: n })}
      emptyLabel={t('needsList.noActiveNeeds')}
      addButton={{ to: '/create', label: t('home.sosNonUrgentTitle') }}
      filterPanel={filterPanel}
      filterCount={chips.length}
      chips={chips}
      fitKey={`${filterWilaya}|${search}|${activeCampaignWilayas.length}`}
      fit={fit}
      emptyView={[[28, 2.6], 5]}
      storageKey="needsView"
    />
  )
}
