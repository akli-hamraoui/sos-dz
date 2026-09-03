import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api, apiUpload, createOrQueue } from '../api'
import { maskPhone, formatDate, compressPhoto, googleMapsUrl } from '../utils'
import { translateApiError } from '../apiErrors'
import { IconMapPin } from '../icons'
import { fetchDrivingRoute } from '../routing'
import CommentThread from '../components/CommentThread'

function statusLabel(t, s) {
  return t(`status.${s}`, s)
}

function ModerationBadge({ t, status, moderatedBy }) {
  let key = 'pending'
  if (status === 'approved') key = moderatedBy === 'admin' ? 'adminApproved' : 'systemApproved'
  else if (status === 'rejected') key = 'rejected'
  return <span className={`moderation-badge moderation-badge-${status === 'rejected' ? 'rejected' : status === 'approved' ? 'approved' : 'pending'}`}>{t(`needDetail.moderationBadge.${key}`)}</span>
}

export default function NeedDetail() {
  const { t, i18n } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { needTokens, saveNeedToken, pickupTokens, savePickupToken, wilayas } = useApp()
  const { showAlert, showConfirm, showPrompt } = useDialog()
  const [need, setNeed] = useState(null)
  const [showPhone, setShowPhone] = useState(false)
  const [revealedPickupPhones, setRevealedPickupPhones] = useState({})
  const [shareLink, setShareLink] = useState('')
  const [canSeeLiveMap, setCanSeeLiveMap] = useState(false)
  const [routeInfo, setRouteInfo] = useState(null)
  const [progressText, setProgressText] = useState({})
  const [deliveryPhotos, setDeliveryPhotos] = useState({})
  const [lightbox, setLightbox] = useState(null) // { src } for a full-size image preview
  const [anonymizingNeed, setAnonymizingNeed] = useState(false)
  const [anonymizingPickupIds, setAnonymizingPickupIds] = useState(() => new Set())
  const mapElRef = useRef(null)
  const mapRef = useRef(null)
  // navigator.geolocation.watchPosition ID per pickup id -- continuous
  // tracking (not a one-shot ping) while location_sharing_active is on and
  // the delivery is still en route; see the sync effect below.
  const watchIdsRef = useRef({})

  const isNeedOwner = needTokens[id] && needTokens[id].access_token
  const viewerToken = searchParams.get('viewer')

  const load = useCallback(async () => {
    const data = await api(`/needs/${id}/`)
    setNeed(data)
  }, [id])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  const checkLiveMapAccess = useCallback(async () => {
    // Always ask the backend rather than gating the request on a locally
    // held token/viewer param -- it's the single source of truth for who
    // may see this (owner token, share-link viewer token, or a logged-in
    // admin's session cookie), and an admin browsing a need they didn't
    // personally create in this browser has neither of the first two but
    // is still authorized. A 403 here just means "not authorized," same
    // as before.
    let qs = ''
    if (isNeedOwner) qs = `?access_token=${needTokens[id].access_token}`
    else if (viewerToken) qs = `?viewer=${viewerToken}`
    try {
      const pickups = await api(`/needs/${id}/pickup-locations/${qs}`)
      setCanSeeLiveMap(true)
      requestAnimationFrame(() => renderDetailMap(pickups))
    } catch {
      setCanSeeLiveMap(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNeedOwner, viewerToken, need, wilayas])

  useEffect(() => {
    if (need) checkLiveMapAccess()
  }, [need, checkLiveMapAccess])

  const destinationPoint = () => {
    if (!need) return null
    if (need.latitude != null && need.longitude != null) return [need.latitude, need.longitude]
    const wilaya = wilayas.find((w) => w.id === need.wilaya)
    return wilaya ? [wilaya.centroid_latitude, wilaya.centroid_longitude] : null
  }

  const renderDetailMap = (pickups) => {
    if (!mapElRef.current) return
    if (mapRef.current) {
      mapRef.current.remove()
      mapRef.current = null
    }
    const map = L.map(mapElRef.current, {
      attributionControl: false,
      gestureHandling: true,
      gestureHandlingOptions: {
        text: { touch: t('map.gestureTouch'), scroll: t('map.gestureScroll'), scrollMac: t('map.gestureScrollMac') },
      },
    })
    // Standard OpenStreetMap raster tiles -- see NeedsList.jsx for why
    // (CartoDB's free tier now requires an API key).
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map)
    L.control.attribution({ prefix: false }).addTo(map)
    mapRef.current = map
    const allPoints = []
    const dest = destinationPoint()
    if (dest) {
      const destIcon = L.divIcon({ className: 'dest-marker-icon', html: '🏁', iconSize: [22, 22] })
      L.marker(dest, { icon: destIcon }).addTo(map).bindPopup(`<strong>${need.title}</strong>`)
      allPoints.push(dest)
    }

    let routedAny = false
    pickups.forEach((entry) => {
      const trail = entry.trail
      if (!trail.length) return
      const latlngs = trail.map((p) => [p.latitude, p.longitude])
      L.polyline(latlngs, { color: '#111' }).addTo(map)
      // A truck pin (Uber-style: a small vehicle glyph on a white circle)
      // instead of Leaflet's default blue map-pin icon, so a responder en
      // route reads at a glance as "a delivery," distinct from the
      // checkered-flag destination marker.
      const truckIcon = L.divIcon({
        className: 'pickup-marker-icon',
        html:
          '<span class="pickup-marker-pin"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#111" stroke-width="1.9" ' +
          'stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5h11v8h-11Z"/><path d="M13.5 11h4l3 2.8v1.7h-7Z"/>' +
          '<circle cx="7" cy="18" r="1.7"/><circle cx="17" cy="18" r="1.7"/><path d="M2.5 16h2.8M15.5 16h.2M18.7 16H21"/></svg></span>',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      })
      const marker = L.marker(latlngs[latlngs.length - 1], { icon: truckIcon }).addTo(map)
      marker.bindPopup(
        `<strong>${entry.pickup.responder_name}</strong><br>${t('needDetail.bringing', { content: entry.pickup.content_brought })}<br>${t('needDetail.latestUpdate', { text: entry.latest_progress_text || '—' })}`
      )
      allPoints.push(...latlngs)

      // Real road-following route from the responder's latest known
      // position to the need's destination (like Google Maps' blue route
      // line) -- distinct from the black trail above, which is the raw
      // history of where they've actually been.
      if (dest && entry.pickup.status === 'en_route') {
        routedAny = true
        fetchDrivingRoute(latlngs[latlngs.length - 1], dest)
          .then((route) => {
            if (mapRef.current !== map) return // map was torn down/re-rendered since this fetch started
            L.polyline(route.coordinates, { color: '#2f6fed', weight: 4, dashArray: '1,10', lineCap: 'round' }).addTo(map)
            map.fitBounds(L.latLngBounds([...allPoints, ...route.coordinates]).pad(0.3), { maxZoom: 15 })
            setRouteInfo({ distanceKm: route.distanceKm, durationMin: route.durationMin })
          })
          .catch(() => setRouteInfo('unavailable'))
      }
    })
    if (!routedAny) setRouteInfo(null)

    if (allPoints.length > 1) {
      // fitBounds on a zero/near-zero-area box (e.g. a single point, or two
      // points right next to each other) zooms all the way to maxZoom
      // (19, the raster tile layer's own cap) since there's no spread to
      // fit -- capping it here keeps a tight cluster of points readable
      // instead of showing a handful of solid-color tiles.
      map.fitBounds(L.latLngBounds(allPoints).pad(0.3), { maxZoom: 15 })
    } else if (allPoints.length === 1) {
      // Common case: a need with no exact GPS falls back to its wilaya's
      // centroid as the only point -- fitBounds() on a single point still
      // zooms to maxZoom for the same reason as above, which is why this
      // used to open on a handful of blank/pink tiles requiring several
      // manual zoom-outs. A real exact position deserves a closer zoom
      // than an approximate wilaya-centroid fallback.
      const zoom = need.position_accuracy === 'exact' ? 15 : 11
      map.setView(allPoints[0], zoom)
    } else {
      map.setView([28.0, 2.6], 5)
    }
  }

  const editNeed = async (patch) => {
    const token = needTokens[id].access_token
    const data = await api(`/needs/${id}/`, { method: 'PATCH', body: JSON.stringify({ ...patch, access_token: token }) })
    setNeed(data)
  }

  const startEdit = async () => {
    const title = await showPrompt(t('createNeed.typeOfNeed') + ':', need.title)
    if (title === null) return
    editNeed({ title })
  }

  const cancelNeed = async () => {
    const reason = await showPrompt(t('needDetail.cancelThisNeed') + '?', '')
    if (reason === null) return
    editNeed({ is_cancelled: true, cancellation_reason: reason })
  }

  const promptUpdateGPS = () => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const token = needTokens[id].access_token
      try {
        const data = await api(`/needs/${id}/update-gps/`, { method: 'POST', body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, access_token: token }) })
        setNeed(data)
      } catch (e) {
        showAlert(translateApiError(e, t))
      }
    })
  }

  const shareTracking = () => {
    const tok = needTokens[id]
    setShareLink(`${window.location.origin}/needs/${id}?viewer=${tok.location_viewer_share_token}`)
  }

  const regenerateShareToken = async () => {
    const token = needTokens[id].access_token
    const result = await api(`/needs/${id}/regenerate-share-token/`, { method: 'POST', body: JSON.stringify({ access_token: token }) })
    saveNeedToken(id, { location_viewer_share_token: result.location_viewer_share_token })
    setShareLink(`${window.location.origin}/needs/${id}?viewer=${result.location_viewer_share_token}`)
  }

  const anonymizeNeed = async () => {
    // Belt-and-suspenders alongside the DialogContext queue fix: a second
    // click while the first is still awaiting confirmation is simply
    // ignored outright, rather than firing a second concurrent request.
    if (anonymizingNeed) return
    setAnonymizingNeed(true)
    try {
      const token = needTokens[id].access_token
      try {
        const data = await api(`/needs/${id}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: token }) })
        setNeed(data)
      } catch (e) {
        if (e.data && e.data.requires_confirmation && (await showConfirm(translateApiError(e, t) + '\n\n' + t('common.confirm') + '?'))) {
          const data = await api(`/needs/${id}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: token, confirm: true }) })
          setNeed(data)
        }
      }
    } finally {
      setAnonymizingNeed(false)
    }
  }

  const reportContent = async (mediaType, mediaId) => {
    const reason = await showPrompt(t('needDetail.reportContent') + '?')
    if (!reason) return
    const reporter_name = (await showPrompt(t('createNeed.name') + ':')) || ''
    const reporter_phone = (await showPrompt(t('createNeed.phone') + ':')) || ''
    await api('/content-reports/', { method: 'POST', body: JSON.stringify({ media_type: mediaType, media_id: mediaId, reporter_name, reporter_phone, reason }) })
    load()
  }

  const reportDuplicate = async () => {
    const referenceId = await showPrompt(t('needDetail.reportAsDuplicate') + ' -- ID:')
    if (!referenceId) return
    const reporter_name = (await showPrompt(t('createNeed.name') + ':')) || ''
    const reporter_phone = (await showPrompt(t('createNeed.phone') + ':')) || ''
    await api(`/needs/${id}/report-duplicate/`, { method: 'POST', body: JSON.stringify({ reference_need_id: referenceId, reporter_name, reporter_phone }) })
    showAlert(t('common.confirm'))
  }

  const addProgressUpdate = async (pickupId) => {
    const text = progressText[pickupId]
    if (!text) return
    const token = pickupTokens[pickupId]
    const result = await createOrQueue({
      type: 'progress_update',
      endpoint: `/api/pickups/${pickupId}/progress-updates/`,
      fields: { free_text: text, access_token: token },
    })
    setProgressText((p) => ({ ...p, [pickupId]: '' }))
    if (result.queued) {
      showAlert(t('offline.pendingSync'))
      return
    }
    load()
  }

  // Continuous tracking (watchPosition), not a one-shot ping -- starts the
  // instant sharing is turned on and keeps sending as the courier's real
  // position changes, until stopLocationWatch tears it down (toggled off,
  // delivered, cancelled, or this page unmounts). Never starts on its own:
  // only ever called from the explicit opt-in toggle below, or the sync
  // effect resuming a share the courier had already turned on.
  const startLocationWatch = useCallback(
    (pickupId) => {
      if (!navigator.geolocation || watchIdsRef.current[pickupId] != null) return
      const token = pickupTokens[pickupId]
      const watchId = navigator.geolocation.watchPosition(
        (pos) => {
          api(`/pickups/${pickupId}/location-pings/`, {
            method: 'POST',
            body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, access_token: token }),
          })
            .then(checkLiveMapAccess)
            .catch(() => {
              /* one failed send (offline blip, delivery just ended server-side) -- watchPosition keeps
                 running and simply retries on the next real position change, no need to tear it down here */
            })
        },
        () => {
          /* GPS temporarily unavailable/denied mid-watch -- never treated as
             fatal or shown as a blocking error; the browser keeps calling
             back on future position changes, per spec 17.4/17.10 (#18). */
        },
        { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
      )
      watchIdsRef.current[pickupId] = watchId
    },
    [pickupTokens, checkLiveMapAccess]
  )

  const stopLocationWatch = useCallback((pickupId) => {
    const watchId = watchIdsRef.current[pickupId]
    if (watchId != null) {
      navigator.geolocation.clearWatch(watchId)
      delete watchIdsRef.current[pickupId]
    }
  }, [])

  const toggleLocationSharing = async (pickup, checked) => {
    const token = pickupTokens[pickup.id]
    // Optimistic stop: never leave the browser still emitting a courier's
    // position for even one more tick once they've said no.
    if (!checked) stopLocationWatch(pickup.id)
    await api(`/pickups/${pickup.id}/`, { method: 'PATCH', body: JSON.stringify({ location_sharing_active: checked, access_token: token }) })
    if (checked) startLocationWatch(pickup.id)
    load()
  }

  // Keeps the actual watchPosition calls in sync with each owned pickup's
  // server-known state -- covers a page reload while sharing was already
  // on (resumes tracking) and, symmetrically, a delivery that just moved
  // to delivered/cancelled (stops it), without the courier having to touch
  // the toggle themselves. Also the effect cleanup that guarantees no
  // watch survives navigating away from this page.
  useEffect(() => {
    if (!need) return
    need.pickups.forEach((p) => {
      const owned = !!pickupTokens[p.id]
      const shouldTrack = owned && p.location_sharing_active && p.status === 'en_route'
      if (shouldTrack) startLocationWatch(p.id)
      else stopLocationWatch(p.id)
    })
    // No cleanup here -- start/stopLocationWatch are idempotent against
    // watchIdsRef, so re-running this sync on every `need`/`pickupTokens`
    // change (e.g. after posting a progress update) is a cheap no-op for
    // pickups whose tracking state hasn't actually changed. A real
    // "stop everything" cleanup belongs to unmount only (below), not to
    // every re-run of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [need, pickupTokens])

  // Guarantees no watchPosition survives navigating away from this page,
  // regardless of what state the pickups were in.
  useEffect(() => {
    return () => {
      Object.keys(watchIdsRef.current).forEach((pid) => stopLocationWatch(pid))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addDeliveryPhotoFile = async (e, pickupId) => {
    const file = e.target.files[0]
    e.target.value = ''
    const current = deliveryPhotos[pickupId] || []
    if (!file || current.length >= 3) return
    const compressed = await compressPhoto(file)
    setDeliveryPhotos((p) => ({ ...p, [pickupId]: [...current, { file: compressed, previewUrl: URL.createObjectURL(compressed) }] }))
  }

  const markDelivered = async (pickupId) => {
    const token = pickupTokens[pickupId]
    const formData = new FormData()
    formData.append('access_token', token)
    ;(deliveryPhotos[pickupId] || []).forEach((p) => formData.append('delivery_photos', p.file, p.file.name))
    await apiUpload(`/pickups/${pickupId}/deliver/`, formData)
    setDeliveryPhotos((p) => ({ ...p, [pickupId]: [] }))
    load()
  }

  const anonymizePickup = async (pickupId) => {
    if (anonymizingPickupIds.has(pickupId)) return
    setAnonymizingPickupIds((prev) => new Set(prev).add(pickupId))
    try {
      const token = pickupTokens[pickupId]
      try {
        await api(`/pickups/${pickupId}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: token }) })
      } catch (e) {
        if (e.data && e.data.requires_confirmation && (await showConfirm(translateApiError(e, t)))) {
          await api(`/pickups/${pickupId}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: token, confirm: true }) })
        }
      }
      load()
    } finally {
      setAnonymizingPickupIds((prev) => {
        const next = new Set(prev)
        next.delete(pickupId)
        return next
      })
    }
  }

  if (!need) return null

  return (
    <section className="detail-page">
      <h2>{need.title}</h2>
      <span className={`badge urgency-${need.urgency}`}>{t(`urgency.${need.urgency}`)}</span> <span className="status">{statusLabel(t, need.overall_status)}</span>
      <p>
        {need.wilaya_name}
        {need.commune ? ' — ' + need.commune : ''}
      </p>
      {need.location_description && <p>{need.location_description}</p>}
      {need.position_accuracy === 'exact' && need.latitude != null && need.longitude != null ? (
        <p>
          <a className="link field-label-icon" href={googleMapsUrl(need.latitude, need.longitude)} target="_blank" rel="noopener noreferrer">
            <IconMapPin width={16} height={16} strokeWidth={2} /> {t('common.openInMaps')}
          </a>
        </p>
      ) : (
        <p className="hint">{t('common.noExactGpsPosition')}</p>
      )}

      {need.voice_file && (
        <div>
          <audio src={need.voice_file} controls />
          <br />
          <button className="link" onClick={() => reportContent('need_media_file', need.id)}>
            {t('needDetail.reportContent')}
          </button>
        </div>
      )}

      {(need.video_file || need.video_moderation_status !== 'approved') && (
        <div>
          <ModerationBadge t={t} status={need.video_moderation_status} moderatedBy={need.video_moderated_by} />
          {!need.video_file && (
            <p className="hint">
              {t('needDetail.recordedMessage', {
                status: need.video_moderation_status === 'rejected' ? t('needDetail.removedByModeration') : t('needDetail.pendingReview'),
              })}
            </p>
          )}
          {need.video_file && (
            <div>
              <video className="media-player" src={need.video_file} controls playsInline preload="auto" />
              <br />
              <button className="link" onClick={() => reportContent('need_media_file', need.id)}>
                {t('needDetail.reportContent')}
              </button>
            </div>
          )}
        </div>
      )}

      {need.damage_photos && need.damage_photos.length > 0 && (
        <div className="photo-thumbs">
          {need.damage_photos.map((photo) => (
            <div className="photo-thumb" key={photo.id}>
              {photo.image ? (
                <button type="button" className="gallery-thumb-btn" onClick={() => setLightbox({ src: photo.image })}>
                  <img className="gallery-thumb" src={photo.image} alt="" />
                </button>
              ) : (
                <ModerationBadge t={t} status={photo.moderation_status} moderatedBy={photo.moderated_by} />
              )}
              {photo.image && (
                <>
                  <ModerationBadge t={t} status={photo.moderation_status} moderatedBy={photo.moderated_by} />
                  <br />
                  <button className="link" onClick={() => reportContent('damage_photo', photo.id)}>
                    {t('needDetail.reportContent')}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <p>
        {t('needDetail.contact')}: {need.contact_name} — {maskPhone(need.contact_phone, showPhone)}{' '}
        <button className="link" onClick={() => setShowPhone(!showPhone)}>
          {showPhone ? t('common.hideNumber') : t('common.showFullNumber')}
        </button>
      </p>
      {/* other_phones is more personal contact info, same as contact_phone
          above -- kept behind the same reveal toggle instead of shown by
          default, same as CollectionPointDetail. */}
      {need.other_phones && showPhone && (
        <p className="multiline-text">
          {t('collectionPoints.otherPhonesLabel')}: {need.other_phones}
        </p>
      )}
      {need.edit_history && need.edit_history.length > 0 && <p>{t('needDetail.editedOn', { date: formatDate(need.edit_history[need.edit_history.length - 1], i18n.language) })}</p>}

      {isNeedOwner ? (
        <div className="owner-actions">
          <h4>{t('needDetail.manageMyNeed')}</h4>
          <button className="btn" onClick={startEdit}>
            {t('common.edit')}
          </button>
          <button className="btn" onClick={cancelNeed}>
            {t('needDetail.cancelThisNeed')}
          </button>
          <button className="btn" onClick={promptUpdateGPS}>
            {t('needDetail.addUpdateGps')}
          </button>
          <button className="btn" onClick={shareTracking}>
            {t('needDetail.shareLiveTracking')}
          </button>
          {shareLink && (
            <p className="share-link">
              {t('needDetail.shareLink')}: <code>{shareLink}</code>{' '}
              <button className="link" onClick={regenerateShareToken}>
                {t('needDetail.regenerate')}
              </button>
            </p>
          )}
          <button className="btn btn-danger" onClick={anonymizeNeed} disabled={anonymizingNeed}>
            {t('needDetail.anonymizeMyInfo')}
          </button>
        </div>
      ) : (
        <div>
          <Link className="link" to="/recover" state={{ type: 'need', id: need.id }}>
            {t('needDetail.isThisYourNeed')}
          </Link>
        </div>
      )}
      <button className="link" onClick={reportDuplicate}>
        {t('needDetail.reportAsDuplicate')}
      </button>

      <h3>{t('needDetail.liveTrackingMap')}</h3>
      {canSeeLiveMap ? (
        <>
          <div className="map-wrap">
            <div id="need-detail-map" ref={mapElRef} style={{ height: 420 }} />
          </div>
          {routeInfo === 'unavailable' && <p className="hint">{t('needDetail.routeUnavailable')}</p>}
          {routeInfo && routeInfo !== 'unavailable' && (
            <p className="status">{t('needDetail.routeDistance', { km: routeInfo.distanceKm.toFixed(1), min: Math.round(routeInfo.durationMin) })}</p>
          )}
        </>
      ) : (
        <p className="hint">{t('needDetail.liveMapRestrictedHint')}</p>
      )}

      <h3>{t('needDetail.pickupsTitle', { count: need.pickups.length })}</h3>
      <button className="btn btn-primary" onClick={() => navigate(`/needs/${id}/take-charge`)}>
        {t('needDetail.alsoTakeCharge')}
      </button>

      {need.pickups.map((p) => {
        const owned = !!pickupTokens[p.id]
        return (
          <div className="pickup-card" key={p.id}>
            <p>
              <strong>{p.responder_name}</strong>{' '}
              <span className="status">{statusLabel(t, p.status)}</span>{' '}
              {p.needs_verification && <span className="badge badge-warn">{t('status.toVerify')}</span>}
            </p>
            {p.responder_phone && (
              <p>
                {maskPhone(p.responder_phone, revealedPickupPhones[p.id])}{' '}
                <button className="link" onClick={() => setRevealedPickupPhones((r) => ({ ...r, [p.id]: !r[p.id] }))}>
                  {revealedPickupPhones[p.id] ? t('common.hideNumber') : t('common.showFullNumber')}
                </button>
              </p>
            )}
            <p>{t('needDetail.bringing', { content: p.content_brought })}</p>
            <div className="timeline">
              {p.progress_updates.map((u) => (
                <div className="timeline-item" key={u.id}>
                  <span className="dot" />
                  <span>
                    {formatDate(u.timestamp, i18n.language)} — {u.free_text}
                  </span>
                </div>
              ))}
            </div>
            {p.delivery_photos && p.delivery_photos.length > 0 && (
              <div className="photo-thumbs">
                {p.delivery_photos.map((photo) => (
                  <div className="photo-thumb" key={photo.id}>
                    {photo.image ? (
                      <button type="button" className="gallery-thumb-btn" onClick={() => setLightbox({ src: photo.image })}>
                        <img className="gallery-thumb" src={photo.image} alt="" />
                      </button>
                    ) : (
                      <ModerationBadge t={t} status={photo.moderation_status} moderatedBy={photo.moderated_by} />
                    )}
                    {photo.image && (
                      <>
                        <ModerationBadge t={t} status={photo.moderation_status} moderatedBy={photo.moderated_by} />
                        <br />
                        <button className="link" onClick={() => reportContent('delivery_photo', photo.id)}>
                          {t('needDetail.reportContent')}
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            {owned && (
              <div className="pickup-owner-actions">
                <input type="text" value={progressText[p.id] || ''} onChange={(e) => setProgressText((pt) => ({ ...pt, [p.id]: e.target.value }))} placeholder={t('needDetail.progressUpdatePlaceholder')} />
                <button className="btn" onClick={() => addProgressUpdate(p.id)}>
                  {t('needDetail.postUpdate')}
                </button>
                <label>
                  <input type="checkbox" checked={p.location_sharing_active} onChange={(e) => toggleLocationSharing(p, e.target.checked)} /> {t('needDetail.shareMyLiveLocation')}
                </label>
                {/* Purely informational -- there's no separate "send now"
                    action anymore, tracking is continuous (watchPosition)
                    for as long as the checkbox above stays on. */}
                {p.location_sharing_active && (
                  <p className="hint field-label-icon">
                    <IconMapPin width={16} height={16} strokeWidth={2} /> {t('needDetail.locationTrackingActive')}
                  </p>
                )}
                {p.status === 'en_route' && (
                  <div>
                    <p className="hint">{t('needDetail.deliveryPhotosLabel')}</p>
                    {(deliveryPhotos[p.id] || []).length < 3 && (
                      <label className="btn record-btn photo-add-btn">
                        {t('createNeed.takePhoto')}
                        <input type="file" accept="image/*" capture="environment" onChange={(e) => addDeliveryPhotoFile(e, p.id)} hidden />
                      </label>
                    )}
                    <div className="photo-thumbs">
                      {(deliveryPhotos[p.id] || []).map((ph, idx) => (
                        <div className="photo-thumb" key={idx}>
                          <img src={ph.previewUrl} alt="" />
                          <button
                            type="button"
                            className="link"
                            onClick={() => setDeliveryPhotos((d) => ({ ...d, [p.id]: d[p.id].filter((_, i) => i !== idx) }))}
                          >
                            {t('createNeed.remove')}
                          </button>
                        </div>
                      ))}
                    </div>
                    <button className="btn btn-primary" onClick={() => markDelivered(p.id)}>
                      {t('needDetail.markAsDelivered')}
                    </button>
                  </div>
                )}
                <button className="btn btn-danger" onClick={() => anonymizePickup(p.id)} disabled={anonymizingPickupIds.has(p.id)}>
                  {t('needDetail.anonymizeMyInfo')}
                </button>
              </div>
            )}
            {!owned && (
              <div>
                <Link className="link" to="/recover" state={{ type: 'pickup', id: p.id }}>
                  {t('needDetail.isThisYourPickup')}
                </Link>
              </div>
            )}
          </div>
        )
      })}

      <CommentThread comments={need.comments || []} target="need" targetId={need.id} onChanged={load} />

      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <button type="button" className="lightbox-close" onClick={() => setLightbox(null)} aria-label={t('needDetail.closeLightbox')}>
            ×
          </button>
          <img src={lightbox.src} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  )
}
