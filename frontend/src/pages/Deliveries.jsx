import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { drawRouteOn, ROUTE_COLOR } from '../routing'
import { TRUCK_GREEN } from '../mapMarkers'
import WilayaCombobox from '../components/WilayaCombobox'
import ExploreMap from '../components/ExploreMap'

// Deliveries in progress, in the shared "explore" view
// (components/ExploreMap.jsx): one truck per courier en route, at their
// latest live position (volunteered by the courier) or, failing that, the
// departure point they declared (muted pin). Refreshed every 20 s without
// moving the map. Tapping a courier draws their road to the destination
// (when it has exact GPS). Deliveries with no position at all are listed
// behind a chip. Filters: wilaya and text search.

const LIVE_REFRESH_INTERVAL_MS = 20000
const TRUCK_SVG =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="{c}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M2.5 7.5h11v8h-11Z"/><path d="M13.5 11h4l3 2.8v1.7h-7Z"/><circle cx="7" cy="18" r="1.7"/><circle cx="17" cy="18" r="1.7"/><path d="M2.5 16h2.8M15.5 16h.2M18.7 16H21"/></svg>'
const TRUCK_WHITE = TRUCK_SVG.replace('{c}', '#fff')
const TRUCK_BIG = TRUCK_SVG.replace('{c}', TRUCK_GREEN).replace('width="18" height="18"', 'width="44" height="44"')

export default function Deliveries() {
  const { t } = useTranslation()
  const location = useLocation()
  const { wilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [live, setLive] = useState([])
  const [pickups, setPickups] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  // Couriers' positions, refreshed in place.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      api('/pickups/live-locations/')
        .then((data) => !cancelled && setLive(data || []))
        .catch(() => {}) // offline: the next tick retries
        .finally(() => !cancelled && setLoading(false))
    load()
    const timer = setInterval(load, LIVE_REFRESH_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [location.key])

  // Every delivery matching the filters (for the "no position" list).
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    if (filterWilaya) params.set('wilaya', filterWilaya)
    if (search) params.set('search', search)
    const qs = params.toString() ? `?${params}` : ''
    api(`/pickups/${qs}`)
      .then((data) => !cancelled && setPickups(data?.results || data || []))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [filterWilaya, search, location.key])

  const wilayaName = wilayas.find((w) => String(w.id) === String(filterWilaya))?.name
  const matches = useCallback(
    (fields, place) => {
      if (wilayaName && place !== wilayaName) return false
      if (!search) return true
      const q = search.toLowerCase()
      return fields.some((f) => (f || '').toLowerCase().includes(q))
    },
    [wilayaName, search]
  )

  const items = useMemo(
    () =>
      live
        .filter((l) => l.latitude != null && matches([l.responder_name, l.content_brought, l.need_title, l.collection_point_name], l.need_wilaya_name || l.collection_point_wilaya_name))
        .map((l) => ({ id: l.pickup_id, lat: l.latitude, lng: l.longitude, exact: true, raw: l })),
    [live, matches]
  )
  const offMapItems = useMemo(() => {
    const located = new Set(live.map((l) => l.pickup_id))
    return pickups
      .filter((p) => p.status === 'en_route' && !located.has(p.id))
      .map((p) => ({
        id: p.id,
        lat: null,
        lng: null,
        raw: {
          pickup_id: p.id,
          responder_name: p.organization_or_person_name || p.responder_name,
          content_brought: p.content_brought,
          need_title: p.need_title,
          need_wilaya_name: p.need_wilaya_name,
          collection_point_name: p.collection_point_name,
          collection_point_wilaya_name: p.collection_point_wilaya_name,
          noPosition: true,
        },
      }))
  }, [pickups, live])

  const pin = useCallback((x) => ({ html: TRUCK_WHITE, color: x.raw.is_live ? TRUCK_GREEN : '#8a99a6', blink: x.raw.is_live }), [])
  const card = useCallback(
    (x) => {
      const l = x.raw
      const dest = l.need_title ? `${l.need_title} — ${l.need_wilaya_name}` : l.collection_point_name ? `${l.collection_point_name} — ${l.collection_point_wilaya_name}` : ''
      return {
        to: `/pickups/${l.pickup_id}`,
        title: l.responder_name,
        subtitle: dest,
        text: l.content_brought ? `${t('deliveries.bringing')} : ${l.content_brought}` : '',
        image: l.photo,
        iconHtml: TRUCK_BIG,
        badges: [
          l.noPosition
            ? { text: t('deliveries.unknownPosition'), tone: 'grey' }
            : l.is_live
              ? { text: t('deliveries.live'), tone: 'green' }
              : { text: l.departure_description ? `${t('deliveries.departure')} (${l.departure_description})` : t('deliveries.departure'), tone: 'grey' },
        ],
      }
    },
    [t]
  )
  // Courier -> destination road, when the destination has exact GPS.
  const onSelect = useCallback((x, overlay) => {
    const l = x.raw
    if (l.destination_latitude == null || l.destination_longitude == null) return
    drawRouteOn(overlay, [x.lat, x.lng], [l.destination_latitude, l.destination_longitude], ROUTE_COLOR, 800)
  }, [])

  const chips = [
    wilayaName && { key: 'wilaya', label: wilayaName, clear: () => setFilterWilaya('') },
    search && { key: 'search', label: `🔎 ${search}`, clear: () => setSearchInput('') },
  ].filter(Boolean)

  const filterPanel = () => (
    <>
      <input type="search" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder={t('deliveries.searchPlaceholder')} aria-label={t('deliveries.searchPlaceholder')} />
      <WilayaCombobox wilayas={wilayas} value={filterWilaya} onChange={setFilterWilaya} placeholder={t('needsList.filterByWilaya')} emptyLabel={t('needsList.all')} />
      <p className="sx-filters-note">{t('deliveries.liveMapNote')}</p>
    </>
  )

  return (
    <ExploreMap
      items={items}
      loading={loading}
      pin={pin}
      card={card}
      clusterColor={TRUCK_GREEN}
      countLabel={(n) => t('deliveries.inArea', { count: n })}
      emptyLabel={t('deliveries.noDeliveries')}
      addButton={{ to: '/needs', label: t('deliveries.deliverShort') }}
      filterPanel={filterPanel}
      filterCount={chips.length}
      chips={chips}
      fitKey={`${filterWilaya}|${search}`}
      emptyView={[[34.5, 3], 5]}
      offMap={{ items: offMapItems, label: t('deliveries.noPositionChip') }}
      onSelect={onSelect}
      storageKey="deliveriesView"
    />
  )
}
