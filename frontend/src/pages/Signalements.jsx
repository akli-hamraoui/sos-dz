import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { translateApiError } from '../apiErrors'
import { formatDate } from '../utils'
import { IconPlus } from '../icons'
import { SIGNALI_CATEGORIES, categoryEmoji } from '../signali'
import '../signali.css'

// The Signali map: every public citizen report (see
// core.signalements.public_signalements), filterable by wilaya, category
// and status. Open reports blink; reports with no exact position (an
// address typed without a map pin, an admin testing from abroad) are
// grouped into one big "no location" bubble instead of piling up on
// their wilaya's centroid. Tapping a pin shows a preview that opens the
// report's own page (SignalementDetail.jsx). ?focus=<id> centers on one
// report -- also fetched on its own, since a report still being checked
// isn't in the public list yet.

function pinIcon(s, selected) {
  const open = s.status === 'new' || s.status === 'in_review'
  const cls = [
    'signali-marker',
    open ? 'is-open' : 'is-resolved',
    s.processing_status === 'pending' ? 'is-pending' : '',
    selected ? 'is-selected' : '',
  ].join(' ')
  return L.divIcon({ className: 'signali-marker-icon', html: `<span class="${cls}">${categoryEmoji(s.category)}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] })
}

function bubbleIcon(count) {
  return L.divIcon({
    className: 'signali-marker-icon',
    html: `<span class="signali-bubble"><span>📍</span><b>${count}</b></span>`,
    iconSize: [64, 64],
    iconAnchor: [32, 32],
  })
}

function Preview({ s }) {
  const { t, i18n } = useTranslation()
  const photo = s.photos.find((p) => p.image)?.image
  return (
    <Link to={`/signalements/${s.id}`} className="signalements-preview">
      {photo ? <img src={photo} alt="" /> : <span className="signalements-list-emoji">{categoryEmoji(s.category)}</span>}
      <span>
        <b>{t(`signali.categories.${s.category}`)}</b>
        <small>{[s.address || s.commune, s.wilaya_name].filter(Boolean).join(' · ')}</small>
        <small>{formatDate(s.created_at, i18n.language)} · {t(`signali.status.${s.status}`)}</small>
        {s.description && <small className="signalements-preview-text">{s.description}</small>}
      </span>
      <em>{t('signali.openReport')} →</em>
    </Link>
  )
}

export default function Signalements() {
  const { t } = useTranslation()
  const { wilayas } = useApp()
  const [params, setParams] = useSearchParams()
  const [items, setItems] = useState([])
  const [focusedReport, setFocused] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [noLocationOnly, setNoLocationOnly] = useState(false)

  const wilaya = params.get('wilaya') || ''
  const category = params.get('category') || ''
  const status = params.get('status') || 'open'
  const focusId = Number(params.get('focus')) || null
  const [selectedId, setSelectedId] = useState(focusId)

  const setFilter = (key, value) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    next.delete('focus')
    setParams(next, { replace: true })
    setNoLocationOnly(false)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const q = new URLSearchParams()
    if (wilaya) q.set('wilaya', wilaya)
    if (category) q.set('category', category)
    if (status !== 'all') q.set('status', status)
    api(`/signalements/?${q}`)
      .then((data) => !cancelled && (setItems(data || []), setError('')))
      .catch((e) => !cancelled && setError(translateApiError(e, t)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [wilaya, category, status, t])

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

  const all = useMemo(() => (focused && !items.some((x) => x.id === focused.id) ? [focused, ...items] : items), [focused, items])
  const located = useMemo(() => all.filter((s) => s.has_exact_position), [all])
  const unlocated = useMemo(() => all.filter((s) => !s.has_exact_position), [all])
  const selected = all.find((x) => x.id === selectedId) || null
  const listed = noLocationOnly ? unlocated : all

  // --- map ---
  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const fittedRef = useRef('')

  useEffect(() => {
    const map = L.map(mapEl.current, {
      attributionControl: false,
      center: [28, 2.6],
      zoom: 5,
      gestureHandling: true,
      gestureHandlingOptions: { text: { touch: t('map.gestureTouch'), scroll: t('map.gestureScroll'), scrollMac: t('map.gestureScrollMac') } },
    })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map)
    L.control.attribution({ prefix: false }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => map.remove()
    // Created once; the gesture hint keeps the language it was opened in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const points = []
    located.forEach((s) => {
      const ll = [s.display_latitude, s.display_longitude]
      points.push(ll)
      L.marker(ll, { icon: pinIcon(s, s.id === selectedId), zIndexOffset: s.id === selectedId ? 1000 : 0, title: t(`signali.categories.${s.category}`) })
        .on('click', () => {
          setSelectedId(s.id)
          setNoLocationOnly(false)
        })
        .addTo(layer)
    })
    if (unlocated.length) {
      // Anchored on the selected wilaya's centroid, or Alger's -- somewhere
      // stable, not wherever the first unlocated report happens to be.
      const w = wilayas.find((x) => String(x.id) === wilaya) || wilayas.find((x) => x.code === '16')
      const ll = w?.centroid_latitude ? [w.centroid_latitude, w.centroid_longitude] : [36.75, 3.06]
      // A plain title, not bindTooltip: the markers are rebuilt on every
      // selection, and an open Leaflet tooltip on a removed marker throws.
      L.marker(ll, { icon: bubbleIcon(unlocated.length), zIndexOffset: 2000, title: `${t('signali.noLocationBubble')} (${unlocated.length})` })
        .on('click', () => {
          setNoLocationOnly(true)
          setSelectedId(null)
          document.querySelector('.signalements-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
        .addTo(layer)
      points.push(ll)
    }
    // Refit only when the filters (or the focused report) change, not on
    // every selection/vote -- the view shouldn't jump under the finger.
    const key = `${wilaya}|${category}|${status}|${focused?.id || ''}|${loading}`
    if (fittedRef.current === key || loading) return
    fittedRef.current = key
    if (focused?.has_exact_position) map.setView([focused.display_latitude, focused.display_longitude], 16)
    else if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 15 })
    else {
      const w = wilayas.find((x) => String(x.id) === wilaya)
      if (w?.centroid_latitude) map.setView([w.centroid_latitude, w.centroid_longitude], 9)
      else map.setView([34.5, 3], 5)
    }
  }, [located, unlocated, selectedId, focused, wilaya, category, status, loading, wilayas, t])

  return (
    <section className="signalements-page">
      <div className="signalements-head">
        <div>
          <h1>📣 {t('signali.listTitle')}</h1>
          <p>{t('signali.listSubtitle')}</p>
        </div>
        <Link to="/signali" className="btn btn-primary signalements-new">
          <IconPlus width={16} height={16} strokeWidth={2.6} /> {t('signali.newReport')}
        </Link>
      </div>

      <div className="signalements-filters">
        <select value={wilaya} onChange={(e) => setFilter('wilaya', e.target.value)} aria-label={t('signali.wilayaLabel')}>
          <option value="">{t('signali.allWilayas')}</option>
          {wilayas.map((w) => (
            <option key={w.id} value={w.id}>{w.code} - {w.name}</option>
          ))}
        </select>
        <select value={category} onChange={(e) => setFilter('category', e.target.value)} aria-label={t('signali.categoryLabel')}>
          <option value="">{t('signali.allCategories')}</option>
          {SIGNALI_CATEGORIES.map((c) => (
            <option key={c} value={c}>{categoryEmoji(c)} {t(`signali.categories.${c}`)}</option>
          ))}
        </select>
        <div className="signalements-status" role="group">
          {['open', 'resolved', 'all'].map((v) => (
            <button key={v} type="button" className={status === v ? 'selected' : ''} onClick={() => setFilter('status', v === 'open' ? '' : v)}>
              {t(`signali.filterStatus.${v}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="signalements-counts">
        <span>{t('signali.countTotal', { count: all.length })}</span>
        {unlocated.length > 0 && (
          <button type="button" className={`signali-link${noLocationOnly ? ' is-active' : ''}`} onClick={() => setNoLocationOnly((v) => !v)}>
            📍 {t('signali.countNoLocation', { count: unlocated.length })}
          </button>
        )}
      </div>

      <div className="signalements-map-frame">
        <div ref={mapEl} className="signalements-map" />
        {!loading && !all.length && <div className="signalements-empty">{t('signali.empty')}</div>}
      </div>
      {error && <p className="error">{error}</p>}

      {selected && <Preview s={selected} />}

      {!!listed.length && (
        <ul className="signalements-list">
          {noLocationOnly && <li className="signalements-list-title">📍 {t('signali.noLocationBubble')}</li>}
          {listed.map((s) => {
            const photo = s.photos.find((p) => p.image)?.image
            return (
              <li key={s.id}>
                <Link to={`/signalements/${s.id}`}>
                  {photo ? <img src={photo} alt="" loading="lazy" /> : <span className="signalements-list-emoji">{categoryEmoji(s.category)}</span>}
                  <span>
                    <b>{t(`signali.categories.${s.category}`)}</b>
                    <small>{[s.address || s.commune, s.wilaya_name].filter(Boolean).join(' · ')}</small>
                  </span>
                  <em>👍 {s.confirmations_count + 1}</em>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
