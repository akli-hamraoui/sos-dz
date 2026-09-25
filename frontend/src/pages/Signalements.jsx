import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { translateApiError } from '../apiErrors'
import WilayaCombobox from '../components/WilayaCombobox'
import ExploreMap from '../components/ExploreMap'
import CategoryIcon from '../components/CategoryIcon'
import { SIGNALI_CATEGORIES, SIGNAL_ICON_SVG, categoryEmoji, categoryIconHtml, getOwnSignalementIds } from '../signali'
import '../signali.css'

// The Signali map: every public citizen report, in the shared "explore"
// view (components/ExploreMap.jsx: full-screen map, list sheet / carousel,
// clusters). Filters (wilaya, type, status, geolocation) live in the URL;
// ?focus=<id> opens on one report (also fetched on its own, in case it
// isn't in the public list), ?near=1 shows the reports within 30 km of the
// visitor (framed, nothing hidden). Reports with no exact position are grouped in one bubble per
// wilaya, on its centre.

// On arrival the map frames this much around the visitor (in Algeria);
// the Home "around me" button (?near=1) a wider area. Nothing is hidden:
// zooming out shows every report.
const ARRIVAL_KM = 30
const NEAR_KM = 100

export default function Signalements() {
  const { t, i18n } = useTranslation()
  const { wilayas, config } = useApp()
  const [params, setParams] = useSearchParams()
  const [ownPending, setOwnPending] = useState([])
  const [reports, setReports] = useState([])
  const [focusedReport, setFocused] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const wilaya = params.get('wilaya') || ''
  const category = params.get('category') || ''
  const status = params.get('status') || 'open'
  const focusId = Number(params.get('focus')) || null
  const geo = params.get('geo') || 'all'
  const nearMode = params.get('near') === '1'

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('focus')
    setParams(next, { replace: true })
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const q = new URLSearchParams()
    if (wilaya) q.set('wilaya', wilaya)
    if (category) q.set('category', category)
    if (status !== 'all') q.set('status', status)
    if (config.is_admin) q.set('include_pending', '1')
    api(`/signalements/?${q}`)
      .then((data) => !cancelled && (setReports(data || []), setError('')))
      .catch((e) => !cancelled && setError(translateApiError(e, t)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [wilaya, category, status, t, config.is_admin])

  // This device's own reports not yet in the public list.
  useEffect(() => {
    const ids = getOwnSignalementIds().slice(-10)
    if (!ids.length) return
    let cancelled = false
    Promise.all(ids.map((id) => api(`/signalements/${id}/`).catch(() => null))).then((rows) => {
      if (!cancelled) setOwnPending(rows.filter((r) => r && r.processing_status === 'pending' && r.status !== 'cancelled'))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const focused = focusedReport && focusedReport.id === focusId ? focusedReport : null
  useEffect(() => {
    if (!focusId) return
    let cancelled = false
    api(`/signalements/${focusId}/`)
      .then((s) => !cancelled && setFocused(s))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [focusId])

  const items = useMemo(() => {
    const extra = [focused, ...ownPending].filter((x, i, arr) => x && !reports.some((y) => y.id === x.id) && arr.findIndex((z) => z && z.id === x.id) === i)
    return [...extra, ...reports]
      .filter((s) => {
        if (geo === 'with' && !s.has_exact_position) return false
        if (geo === 'without' && s.has_exact_position) return false
        return true
      })
      .map((s) => ({
        id: s.id,
        lat: s.display_latitude,
        lng: s.display_longitude,
        exact: s.has_exact_position,
        group: s.has_exact_position ? undefined : `w${s.wilaya}`,
        raw: s,
      }))
  }, [focused, ownPending, reports, geo])

  const pin = useCallback((x) => {
    const open = x.raw.status === 'new' || x.raw.status === 'in_review'
    return { html: categoryIconHtml(x.raw.category), color: open ? '#1f5fbf' : '#2f8f5b', blink: open }
  }, [])
  const card = useCallback(
    (x) => {
      const s = x.raw
      const open = s.status === 'new' || s.status === 'in_review'
      return {
        to: `/signalements/${s.id}`,
        title: t(`signali.categories.${s.category}`),
        subtitle: [s.address || s.commune, s.wilaya_name].filter(Boolean).join(' · '),
        text: (s.description || s.voice_transcript || '').trim(),
        image: s.photos.find((p) => p.image)?.image,
        video: s.video_file,
        iconHtml: categoryIconHtml(s.category),
        meta: [`👍 ${s.confirmations_count + 1}`, new Date(s.created_at).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short' })],
        badges: [
          { text: t(`signali.status.${s.status}`), tone: open ? 'blue' : 'green' },
          ...(s.has_exact_position ? [] : [{ text: t('signali.approxLocation'), tone: 'grey' }]),
        ],
      }
    },
    [t, i18n.language]
  )
  const bubble = useCallback(
    (members) => ({
      html: `<span class="signali-bubble">${SIGNAL_ICON_SVG}<b>${members.length}</b></span>`,
      label: `${t('signali.noLocationBubble')} · ${members[0].raw.wilaya_name}`,
    }),
    [t]
  )
  const fit = useCallback(
    (map, points, pad) => {
      if (points.length) return map.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 15, ...pad })
      const w = wilayas.find((x) => String(x.id) === wilaya)
      if (w?.centroid_latitude) map.setView([w.centroid_latitude, w.centroid_longitude], 9)
      else map.setView([34.5, 3], 5)
    },
    [wilayas, wilaya]
  )

  const wilayaName = wilayas.find((w) => String(w.id) === wilaya)?.name
  const chips = [
    nearMode && { key: 'near', label: `📍 ${t('signali.nearMe', { km: NEAR_KM })}`, clear: () => setFilter('near', '') },
    wilayaName && { key: 'wilaya', label: wilayaName, clear: () => setFilter('wilaya', '') },
    category && {
      key: 'category',
      label: (
        <>
          <CategoryIcon category={category} /> {t(`signali.categories.${category}`)}
        </>
      ),
      clear: () => setFilter('category', ''),
    },
    status !== 'open' && { key: 'status', label: t(`signali.filterStatus.${status}`), clear: () => setFilter('status', '') },
    geo !== 'all' && { key: 'geo', label: t(`signali.filterGeo.${geo}`), clear: () => setFilter('geo', '') },
  ].filter(Boolean)

  const filterPanel = () => (
    <>
      <WilayaCombobox wilayas={wilayas} value={wilaya} onChange={(v) => setFilter('wilaya', v)} placeholder={t('signali.allWilayas')} emptyLabel={t('signali.allWilayas')} />
      <select value={category} onChange={(e) => setFilter('category', e.target.value)} aria-label={t('signali.categoryLabel')}>
        <option value="">{t('signali.allCategories')}</option>
        {SIGNALI_CATEGORIES.map((c) => (
          <option key={c} value={c}>{categoryEmoji(c)} {t(`signali.categories.${c}`)}</option>
        ))}
      </select>
      <div className="sx-seg" role="group" aria-label={t('signali.statusLabel')}>
        {['open', 'resolved', 'all'].map((v) => (
          <button key={v} type="button" className={status === v ? 'selected' : ''} onClick={() => setFilter('status', v === 'open' ? '' : v)}>
            {t(`signali.filterStatus.${v}`)}
          </button>
        ))}
      </div>
      <div className="sx-seg" role="group" aria-label={t('signali.geoLabel')}>
        {['all', 'with', 'without'].map((v) => (
          <button key={v} type="button" className={geo === v ? 'selected' : ''} onClick={() => setFilter('geo', v === 'all' ? '' : v)}>
            {t(`signali.filterGeo.${v}`)}
          </button>
        ))}
      </div>
    </>
  )

  return (
    <ExploreMap
      items={items}
      loading={loading}
      error={error}
      pin={pin}
      card={card}
      bubble={bubble}
      countLabel={(n) => t('signali.inArea', { count: n })}
      emptyLabel={t('signali.empty')}
      addButton={{ to: '/signali', label: t('signali.newReport') }}
      filterPanel={filterPanel}
      filterCount={chips.filter((c) => c.key !== 'near').length}
      chips={chips}
      fitKey={`${wilaya}|${category}|${status}|${geo}|${nearMode ? 'near' : ''}`}
      fit={fit}
      focusId={focusId}
      aroundMeKm={wilaya ? 0 : nearMode ? NEAR_KM : ARRIVAL_KM}
      storageKey="signalementsView"
    />
  )
}
