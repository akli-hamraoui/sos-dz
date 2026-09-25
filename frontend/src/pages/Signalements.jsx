import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { translateApiError } from '../apiErrors'
import { formatDate, googleMapsDirectionsUrl } from '../utils'
import PhotoLightbox from '../components/PhotoLightbox'
import { IconPlus } from '../icons'
import { SIGNALI_CATEGORIES, categoryEmoji, getSignalementToken } from '../signali'
import '../signali.css'

// The Signali map: every public citizen report (see
// core.signalements.public_signalements), filterable by wilaya, category
// and open/resolved. Arriving from the wizard (?focus=<id>) centers on the
// report just sent -- which the list doesn't contain yet, since it's
// hidden until the background moderation has run -- so that one is
// fetched on its own and shown as "being checked".

function pinIcon(s, selected) {
  const cls = `signali-marker${s.status === 'resolved' ? ' is-resolved' : ''}${s.processing_status === 'pending' ? ' is-pending' : ''}${selected ? ' is-selected' : ''}`
  return L.divIcon({ className: 'signali-marker-icon', html: `<span class="${cls}">${categoryEmoji(s.category)}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] })
}

function Detail({ s, onChange, onPhoto }) {
  const { t, i18n } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const token = getSignalementToken(s.id)
  const pending = s.processing_status === 'pending'
  const resolved = s.status === 'resolved'
  const transcripts = [s.voice_transcript, s.video_transcript].filter((x) => x && x.trim())

  const vote = async (path, done) => {
    setBusy(true)
    setMessage('')
    try {
      const updated = await api(`/signalements/${s.id}/${path}/`, {
        method: 'POST',
        headers: token ? { 'X-Access-Token': token } : {},
      })
      onChange(updated)
      setMessage(done)
    } catch (e) {
      setMessage(translateApiError(e, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="signali-detail">
      <header>
        <span className="signali-detail-emoji" aria-hidden="true">{categoryEmoji(s.category)}</span>
        <div>
          <h2>{t(`signali.categories.${s.category}`)}</h2>
          <small>{[s.address, s.commune, s.wilaya_name].filter(Boolean).join(', ')}</small>
        </div>
        <span className={`signali-status${resolved ? ' is-resolved' : pending ? ' is-pending' : ''}`}>
          {resolved ? t('signali.statusResolved') : pending ? t('signali.statusPending') : t('signali.statusOpen')}
        </span>
      </header>
      {pending && <p className="signali-pending-note">{t('signali.pendingNote')}</p>}

      {(s.photos.some((p) => p.image) || s.video_file) && (
        <div className="signali-detail-media">
          {s.photos.filter((p) => p.image).map((p) => (
            <button type="button" key={p.id} onClick={() => onPhoto(p.image)} className="signali-detail-photo">
              <img src={p.image} alt={t('common.photoAlt')} loading="lazy" />
            </button>
          ))}
          {s.video_file && <video src={s.video_file} controls playsInline preload="metadata" />}
        </div>
      )}

      {s.description && <p className="signali-detail-text">{s.description}</p>}
      {transcripts.map((x, i) => (
        <blockquote key={i} className="signali-transcript">🎙️ {x}</blockquote>
      ))}
      {s.voice_file && <audio src={s.voice_file} controls preload="none" />}

      <div className="signali-detail-meta">
        <span>{formatDate(s.created_at, i18n.language)}</span>
        {s.category_suggested_by_ai && <span>✨ {t('signali.aiCategory')}</span>}
        <span>👍 {t('signali.confirmationsCount', { count: s.confirmations_count + 1 })}</span>
        {s.fixed_reports_count > 0 && !resolved && <span>🔧 {t('signali.fixedCount', { count: s.fixed_reports_count })}</span>}
      </div>

      <div className="signali-detail-actions">
        {!resolved && !pending && (
          <button type="button" className="btn" onClick={() => vote('confirm', t('signali.thanksConfirm'))} disabled={busy}>
            👍 {t('signali.stillThere')}
          </button>
        )}
        {!resolved && (token || !pending) && (
          <button type="button" className="btn" onClick={() => vote('report-fixed', token ? t('signali.thanksResolved') : t('signali.thanksFixed'))} disabled={busy}>
            🔧 {token ? t('signali.markResolved') : t('signali.itsFixed')}
          </button>
        )}
        <a className="btn" href={googleMapsDirectionsUrl(s.display_latitude, s.display_longitude)} target="_blank" rel="noreferrer">
          {t('common.openInMaps')}
        </a>
      </div>
      {message && <p className="signali-message" role="status">{message}</p>}
    </article>
  )
}

export default function Signalements() {
  const { t } = useTranslation()
  const { wilayas } = useApp()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const [items, setItems] = useState([])
  const [focusedReport, setFocused] = useState(null) // the ?focus= report when not in the list
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lightbox, setLightbox] = useState(null)
  const justCreated = location.state?.justCreated

  const wilaya = params.get('wilaya') || ''
  const category = params.get('category') || ''
  const status = params.get('status') || 'new'
  const focusId = Number(params.get('focus')) || null
  const [selectedId, setSelectedId] = useState(focusId)

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
  const selected = all.find((x) => x.id === selectedId) || null

  const onChange = useCallback((updated) => {
    setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)))
    setFocused((prev) => (prev && prev.id === updated.id ? updated : prev))
  }, [])

  // --- map ---
  const mapEl = useRef(null)
  const mapRef = useRef(null)
  const layerRef = useRef(null)
  const detailRef = useRef(null)
  const fittedRef = useRef('')

  useEffect(() => {
    const map = L.map(mapEl.current, { attributionControl: false, center: [28, 2.6], zoom: 5, gestureHandling: true })
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map)
    L.control.attribution({ prefix: false }).addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    mapRef.current = map
    return () => map.remove()
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return
    layer.clearLayers()
    const points = []
    all.forEach((s) => {
      if (s.display_latitude == null) return
      const ll = [s.display_latitude, s.display_longitude]
      points.push(ll)
      L.marker(ll, { icon: pinIcon(s, s.id === selectedId), zIndexOffset: s.id === selectedId ? 1000 : 0, title: t(`signali.categories.${s.category}`) })
        .on('click', () => {
          setSelectedId(s.id)
          requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
        })
        .addTo(layer)
    })
    // Refit only when the filters (or the focused report) change, not on
    // every selection/vote -- the view shouldn't jump under the finger.
    const key = `${wilaya}|${category}|${status}|${focused?.id || ''}|${loading}`
    if (fittedRef.current === key || loading) return
    fittedRef.current = key
    if (focused?.display_latitude != null) map.setView([focused.display_latitude, focused.display_longitude], 16)
    else if (points.length) map.fitBounds(L.latLngBounds(points).pad(0.25), { maxZoom: 15 })
    else {
      const w = wilayas.find((x) => String(x.id) === wilaya)
      if (w?.centroid_latitude) map.setView([w.centroid_latitude, w.centroid_longitude], 9)
      else map.setView([34.5, 3], 5)
    }
  }, [all, selectedId, focused, wilaya, category, status, loading, wilayas, t])

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

      {justCreated && (
        <div className="signali-created" role="status">
          <strong>✓ {t('signali.createdTitle')}</strong>
          <span>{t('signali.createdText')}</span>
        </div>
      )}

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
          {['new', 'resolved', 'all'].map((v) => (
            <button key={v} type="button" className={status === v ? 'selected' : ''} onClick={() => setFilter('status', v === 'new' ? '' : v)}>
              {t(`signali.filterStatus.${v}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="signalements-map-frame">
        <div ref={mapEl} className="signalements-map" />
        {!loading && !all.length && <div className="signalements-empty">{t('signali.empty')}</div>}
      </div>
      {error && <p className="error">{error}</p>}

      <div ref={detailRef}>{selected && <Detail key={selected.id} s={selected} onChange={onChange} onPhoto={setLightbox} />}</div>

      {!!all.length && (
        <ul className="signalements-list">
          {all.map((s) => {
            const photo = s.photos.find((p) => p.image)?.image
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className={s.id === selectedId ? 'selected' : ''}
                  onClick={() => {
                    setSelectedId(s.id)
                    if (s.display_latitude != null) mapRef.current?.setView([s.display_latitude, s.display_longitude], 16)
                    mapEl.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }}
                >
                  {photo ? <img src={photo} alt="" loading="lazy" /> : <span className="signalements-list-emoji">{categoryEmoji(s.category)}</span>}
                  <span>
                    <b>{t(`signali.categories.${s.category}`)}</b>
                    <small>{[s.address || s.commune, s.wilaya_name].filter(Boolean).join(' · ')}</small>
                  </span>
                  <em>👍 {s.confirmations_count + 1}</em>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <PhotoLightbox src={lightbox} onClose={() => setLightbox(null)} />
    </section>
  )
}
