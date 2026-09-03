import { useState, useRef, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api, apiUpload, createOrQueue } from '../api'
import { maskPhone, formatDate, compressPhoto } from '../utils'
import { translateApiError } from '../apiErrors'
import { IconMapPin } from '../icons'
import ModerationBadge from './ModerationBadge'

function statusLabel(t, s) {
  return t(`status.${s}`, s)
}

// One delivery/pickup's full owner-and-viewer UI: status, progress
// timeline, delivery photos, live-location opt-in tracking (continuous
// watchPosition, never a one-shot ping -- see spec 17), mark-as-delivered,
// and anonymize. Originally inlined in NeedDetail.jsx only; extracted so a
// CollectionPoint's own pickups (courier picking up/dropping off at a
// collection point instead of a Need) get the exact same logic instead of
// a second, divergent copy -- same Pickup model and endpoints either way,
// just linked to collection_point instead of need.
export default function PickupManager({ pickup, pickupToken, onChange }) {
  const { t, i18n } = useTranslation()
  const { refreshConfig } = useApp()
  const { showConfirm, showPrompt } = useDialog()
  const owned = !!pickupToken

  const [revealedPhone, setRevealedPhone] = useState(false)
  const [progressText, setProgressText] = useState('')
  const [deliveryPhotos, setDeliveryPhotos] = useState([])
  const [lightbox, setLightbox] = useState(null)
  const [anonymizing, setAnonymizing] = useState(false)
  const watchIdRef = useRef(null)

  const startLocationWatch = useCallback(() => {
    if (!navigator.geolocation || watchIdRef.current != null) return
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        api(`/pickups/${pickup.id}/location-pings/`, {
          method: 'POST',
          body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, access_token: pickupToken }),
        }).catch(() => {
          /* one failed send (offline blip, delivery just ended server-side) -- watchPosition keeps
             running and simply retries on the next real position change, no need to tear it down here */
        })
      },
      () => {
        /* GPS temporarily unavailable/denied mid-watch -- never treated as
           fatal or shown as a blocking error, per spec 17.4/17.10. */
      },
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    )
  }, [pickup.id, pickupToken])

  const stopLocationWatch = useCallback(() => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
  }, [])

  // Keeps the actual watchPosition call in sync with this pickup's own
  // server-known state -- resumes tracking on a page reload while sharing
  // was already on, and stops it the instant the pickup moves to
  // delivered/cancelled, without the courier having to touch the toggle.
  useEffect(() => {
    const shouldTrack = owned && pickup.location_sharing_active && pickup.status === 'en_route'
    if (shouldTrack) startLocationWatch()
    else stopLocationWatch()
  }, [owned, pickup.location_sharing_active, pickup.status, startLocationWatch, stopLocationWatch])

  useEffect(() => stopLocationWatch, [stopLocationWatch])

  const toggleLocationSharing = async (checked) => {
    if (!checked) stopLocationWatch()
    await api(`/pickups/${pickup.id}/`, { method: 'PATCH', body: JSON.stringify({ location_sharing_active: checked, access_token: pickupToken }) })
    if (checked) startLocationWatch()
    onChange()
  }

  const addProgressUpdate = async () => {
    if (!progressText) return
    const result = await createOrQueue({
      type: 'progress_update',
      endpoint: `/api/pickups/${pickup.id}/progress-updates/`,
      fields: { free_text: progressText, access_token: pickupToken },
    })
    setProgressText('')
    if (result.queued) return
    onChange()
  }

  const addDeliveryPhotoFile = async (e) => {
    const file = e.target.files[0]
    e.target.value = ''
    if (!file || deliveryPhotos.length >= 3) return
    const compressed = await compressPhoto(file)
    setDeliveryPhotos((prev) => [...prev, { file: compressed, previewUrl: URL.createObjectURL(compressed) }])
  }

  const markDelivered = async () => {
    const formData = new FormData()
    formData.append('access_token', pickupToken)
    deliveryPhotos.forEach((p) => formData.append('delivery_photos', p.file, p.file.name))
    await apiUpload(`/pickups/${pickup.id}/deliver/`, formData)
    setDeliveryPhotos([])
    onChange()
    refreshConfig()
  }

  const anonymize = async () => {
    if (anonymizing) return
    setAnonymizing(true)
    try {
      try {
        await api(`/pickups/${pickup.id}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: pickupToken }) })
      } catch (e) {
        if (e.data && e.data.requires_confirmation && (await showConfirm(translateApiError(e, t)))) {
          await api(`/pickups/${pickup.id}/anonymize/`, { method: 'POST', body: JSON.stringify({ access_token: pickupToken, confirm: true }) })
        }
      }
      onChange()
    } finally {
      setAnonymizing(false)
    }
  }

  const reportContent = async (mediaType, mediaId) => {
    const reason = await showPrompt(t('needDetail.reportContent') + '?')
    if (!reason) return
    const reporter_name = (await showPrompt(t('createNeed.name') + ':')) || ''
    const reporter_phone = (await showPrompt(t('createNeed.phone') + ':')) || ''
    await api('/content-reports/', { method: 'POST', body: JSON.stringify({ media_type: mediaType, media_id: mediaId, reporter_name, reporter_phone, reason }) })
    onChange()
  }

  return (
    <div className="pickup-card">
      <p>
        <strong>{pickup.responder_name}</strong> <span className="status">{statusLabel(t, pickup.status)}</span>{' '}
        {pickup.needs_verification && <span className="badge badge-warn">{t('status.toVerify')}</span>}
      </p>
      {pickup.responder_phone && (
        <p>
          {maskPhone(pickup.responder_phone, revealedPhone)}{' '}
          <button className="link" onClick={() => setRevealedPhone((r) => !r)}>
            {revealedPhone ? t('common.hideNumber') : t('common.showFullNumber')}
          </button>
        </p>
      )}
      <p>{t('needDetail.bringing', { content: pickup.content_brought })}</p>
      <div className="timeline">
        {pickup.progress_updates.map((u) => (
          <div className="timeline-item" key={u.id}>
            <span className="dot" />
            <span>
              {formatDate(u.timestamp, i18n.language)} — {u.free_text}
            </span>
          </div>
        ))}
      </div>
      {pickup.delivery_photos && pickup.delivery_photos.length > 0 && (
        <div className="photo-thumbs">
          {pickup.delivery_photos.map((photo) => (
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
          <input type="text" value={progressText} onChange={(e) => setProgressText(e.target.value)} placeholder={t('needDetail.progressUpdatePlaceholder')} />
          <button className="btn" onClick={addProgressUpdate}>
            {t('needDetail.postUpdate')}
          </button>
          <label>
            <input type="checkbox" checked={pickup.location_sharing_active} onChange={(e) => toggleLocationSharing(e.target.checked)} /> {t('needDetail.shareMyLiveLocation')}
          </label>
          {pickup.location_sharing_active && (
            <p className="hint field-label-icon">
              <IconMapPin width={16} height={16} strokeWidth={2} /> {t('needDetail.locationTrackingActive')}
            </p>
          )}
          {pickup.status === 'en_route' && (
            <div>
              <p className="hint">{t('needDetail.deliveryPhotosLabel')}</p>
              {deliveryPhotos.length < 3 && (
                <label className="btn record-btn photo-add-btn">
                  {t('createNeed.takePhoto')}
                  <input type="file" accept="image/*" capture="environment" onChange={addDeliveryPhotoFile} hidden />
                </label>
              )}
              <div className="photo-thumbs">
                {deliveryPhotos.map((ph, idx) => (
                  <div className="photo-thumb" key={idx}>
                    <img src={ph.previewUrl} alt="" />
                    <button type="button" className="link" onClick={() => setDeliveryPhotos((d) => d.filter((_, i) => i !== idx))}>
                      {t('createNeed.remove')}
                    </button>
                  </div>
                ))}
              </div>
              <button className="btn btn-primary" onClick={markDelivered}>
                {t('needDetail.markAsDelivered')}
              </button>
            </div>
          )}
          <button className="btn btn-danger" onClick={anonymize} disabled={anonymizing}>
            {t('needDetail.anonymizeMyInfo')}
          </button>
        </div>
      )}
      {!owned && (
        <div>
          <Link className="link" to="/recover" state={{ type: 'pickup', id: pickup.id }}>
            {t('needDetail.isThisYourPickup')}
          </Link>
        </div>
      )}
      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <button type="button" className="lightbox-close" onClick={() => setLightbox(null)} aria-label={t('needDetail.closeLightbox')}>
            ×
          </button>
          <img src={lightbox.src} alt="" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  )
}
