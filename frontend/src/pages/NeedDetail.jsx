import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useSearchParams, Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import L from 'leaflet'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api, apiUpload, createOrQueue } from '../api'
import { maskPhone, formatDate, compressPhoto } from '../utils'
import { IconMapPin } from '../icons'
import { fetchDrivingRoute } from '../routing'
import CommentThread from '../components/CommentThread'

function statusLabel(t, s) {
  return t(`status.${s}`, s)
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
  const mapElRef = useRef(null)
  const mapRef = useRef(null)

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
    const map = L.map(mapElRef.current, { attributionControl: false })
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
      const marker = L.marker(latlngs[latlngs.length - 1]).addTo(map)
      marker.bindPopup(
        `<strong>${entry.pickup.responder_name}</strong><br>Bringing: ${entry.pickup.content_brought}<br>Latest: ${entry.latest_progress_text || '—'}`
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
            map.fitBounds(L.latLngBounds([...allPoints, ...route.coordinates]).pad(0.3))
            setRouteInfo({ distanceKm: route.distanceKm, durationMin: route.durationMin })
          })
          .catch(() => setRouteInfo('unavailable'))
      }
    })
    if (!routedAny) setRouteInfo(null)

    if (allPoints.length) map.fitBounds(L.latLngBounds(allPoints).pad(0.3))
    else map.setView([28.0, 2.6], 5)
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
        showAlert(e.message)
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
    const token = needTokens[id].access_token
    try {
      const data = await api(`/needs/${id}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: token }) })
      setNeed(data)
    } catch (e) {
      if (e.data && e.data.requires_confirmation && (await showConfirm(e.data.detail + '\n\n' + t('common.confirm') + '?'))) {
        const data = await api(`/needs/${id}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: token, confirm: true }) })
        setNeed(data)
      }
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

  const toggleLocationSharing = async (pickup, checked) => {
    const token = pickupTokens[pickup.id]
    await api(`/pickups/${pickup.id}/`, { method: 'PATCH', body: JSON.stringify({ location_sharing_active: checked, access_token: token }) })
    load()
  }

  const pingLocation = (pickupId) => {
    if (!navigator.geolocation) return
    const token = pickupTokens[pickupId]
    navigator.geolocation.getCurrentPosition(async (pos) => {
      await api(`/pickups/${pickupId}/location-pings/`, { method: 'POST', body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, access_token: token }) })
      checkLiveMapAccess()
    })
  }

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
    const token = pickupTokens[pickupId]
    try {
      await api(`/pickups/${pickupId}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: token }) })
    } catch (e) {
      if (e.data && e.data.requires_confirmation && (await showConfirm(e.data.detail))) {
        await api(`/pickups/${pickupId}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: token, confirm: true }) })
      }
    }
    load()
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
      {need.position_accuracy !== 'exact' && <p className="hint">{t('common.noExactGpsPosition')}</p>}

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
          {!need.video_file && (
            <p className="hint">
              {t('needDetail.recordedMessage', {
                status: need.video_moderation_status === 'rejected' ? t('needDetail.removedByModeration') : t('needDetail.pendingReview'),
              })}
            </p>
          )}
          {need.video_file && (
            <div>
              <video src={need.video_file} controls style={{ maxWidth: '100%' }} />
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
                <a href={photo.image} target="_blank" rel="noreferrer">
                  <img className="gallery-thumb" src={photo.image} alt="" />
                </a>
              ) : (
                <span className="hint">{photo.moderation_status === 'rejected' ? t('needDetail.removed') : t('needDetail.pendingReview')}</span>
              )}
              {photo.image && (
                <>
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
          <button className="btn btn-danger" onClick={anonymizeNeed}>
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
          <div id="need-detail-map" ref={mapElRef} style={{ height: 420 }} />
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
                      <a href={photo.image} target="_blank" rel="noreferrer">
                        <img className="gallery-thumb" src={photo.image} alt="" />
                      </a>
                    ) : (
                      <span className="hint">{photo.moderation_status === 'rejected' ? t('needDetail.removed') : t('needDetail.pendingReview')}</span>
                    )}
                    {photo.image && (
                      <>
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
                {p.location_sharing_active && (
                  <button className="btn btn-icon" onClick={() => pingLocation(p.id)}>
                    <IconMapPin width={16} height={16} strokeWidth={2} /> {t('needDetail.updatePositionNow')}
                  </button>
                )}
                {p.status === 'en_route' && (
                  <div>
                    <label>
                      {t('needDetail.deliveryPhotosLabel')}
                      {(deliveryPhotos[p.id] || []).length < 3 && <input type="file" accept="image/*" capture="environment" onChange={(e) => addDeliveryPhotoFile(e, p.id)} />}
                    </label>
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
                <button className="btn btn-danger" onClick={() => anonymizePickup(p.id)}>
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
    </section>
  )
}
