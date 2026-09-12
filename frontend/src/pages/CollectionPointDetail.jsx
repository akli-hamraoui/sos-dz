import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useDialog } from '../context/DialogContext'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { maskPhone, googleMapsDirectionsUrl, getCurrentPosition } from '../utils'
import { translateApiError } from '../apiErrors'
import CommentThread from '../components/CommentThread'
import ModerationBadge from '../components/ModerationBadge'
import PickupManager from '../components/PickupManager'
import { IconFacebook, IconTikTok, IconInstagram, IconMapPin } from '../icons'

// Belt-and-suspenders on top of the server-side validation (which already
// only ever accepts/stores http(s) URLs, see core/validators.py): never
// render an <a href> for anything that isn't clearly http(s), regardless
// of where the value came from.
const isSafeHttpUrl = (url) => typeof url === 'string' && /^https?:\/\//i.test(url)

const SOCIAL_NETWORKS = [
  { field: 'facebook_url', name: 'Facebook', Icon: IconFacebook },
  { field: 'tiktok_url', name: 'TikTok', Icon: IconTikTok },
  { field: 'instagram_url', name: 'Instagram', Icon: IconInstagram },
]

export default function CollectionPointDetail() {
  const { t } = useTranslation()
  const { id } = useParams()
  const navigate = useNavigate()
  const { showAlert, showPrompt, showConfirm } = useDialog()
  const { refreshConfig, pickupTokens, cpTokens, removeCpToken } = useApp()
  const [cp, setCp] = useState(null)
  const [showPhone, setShowPhone] = useState(false)
  const [lightbox, setLightbox] = useState(null) // { src } for a full-size flyer preview
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const isOwner = !!cpTokens[id]
  // Fetched eagerly in the background on mount, not awaited at click time
  // (see the Maps button below) -- a browser's "this navigation was
  // directly triggered by the user" activation window is short-lived
  // (a few seconds) and does not survive an async gap of unpredictable
  // length (a fresh GPS fix can take several seconds, denial can take
  // even longer to time out). A navigation issued after that window has
  // expired is no longer treated as user-initiated, which is exactly the
  // kind of thing that makes Android's Maps-app handoff intermittently
  // fail into a blank tab -- fast fix, works; slow fix, blank. Prefetching
  // means the click handler itself is purely synchronous, so by the time
  // anyone actually taps the button (they've had the page open at least a
  // few seconds already, reading the details), the position is very
  // likely already sitting here, ready or not.
  const originRef = useRef(null)

  const load = useCallback(async () => {
    setCp(await api(`/collection-points/${id}/`))
  }, [id])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  useEffect(() => {
    getCurrentPosition().then((origin) => {
      originRef.current = origin
    })
  }, [])

  const reportFlyer = async () => {
    const reason = await showPrompt(t('needDetail.reportContent') + '?')
    if (!reason) return
    const reporter_name = (await showPrompt(t('createNeed.name') + ':')) || ''
    const reporter_phone = (await showPrompt(t('createNeed.phone') + ':')) || ''
    await api('/content-reports/', { method: 'POST', body: JSON.stringify({ media_type: 'collection_point_flyer', media_id: cp.id, reporter_name, reporter_phone, reason }) })
    load()
  }

  const closePointOwned = async () => {
    try {
      setCp(await api(`/collection-points/${id}/close/`, { method: 'POST', body: JSON.stringify({ access_token: cpTokens[id] }) }))
      refreshConfig()
    } catch (e) {
      showAlert(translateApiError(e, t))
    }
  }

  const closePointByIdentity = async () => {
    // Name+phone are optional at creation now -- a point created with a
    // recovery code instead has nothing to match against on the
    // name/phone path, so that's offered first and only falls back to
    // name+phone if left blank.
    const code = await showPrompt(t('collectionPoints.closePromptCode'))
    if (code === null) return
    let payload
    if (code.trim()) {
      payload = { code: code.trim() }
    } else {
      const contact_name = await showPrompt(t('collectionPoints.closePromptName'))
      if (!contact_name) return
      const contact_phone = await showPrompt(t('collectionPoints.closePromptPhone'))
      payload = { contact_name, contact_phone }
    }
    try {
      setCp(await api(`/collection-points/${id}/close/`, { method: 'POST', body: JSON.stringify(payload) }))
      refreshConfig()
    } catch (e) {
      showAlert(translateApiError(e, t))
    }
  }

  // Full edit form covering every field CollectionPointViewSet.partial_update
  // accepts (its own editable_fields allowlist, backend) -- same fields as
  // CreateCollectionPoint/CreateInternationalCollectionPoint minus wilaya/
  // country/GPS/flyer, which that endpoint deliberately excludes.
  const startEdit = () => {
    setEditForm({
      point_name: cp.point_name,
      organization: cp.organization,
      location_description: cp.location_description,
      hours: cp.hours,
      description: cp.description,
      accepted_donations: cp.accepted_donations,
      contact_name: cp.contact_name,
      contact_phone: cp.contact_phone,
      other_phones: cp.other_phones,
      facebook_url: cp.facebook_url || '',
      tiktok_url: cp.tiktok_url || '',
      instagram_url: cp.instagram_url || '',
    })
    setEditing(true)
  }

  const setEditField = (key) => (e) => setEditForm((f) => ({ ...f, [key]: e.target.value }))

  const saveEditOwned = async (e) => {
    e.preventDefault()
    try {
      setCp(await api(`/collection-points/${id}/`, { method: 'PATCH', body: JSON.stringify({ ...editForm, access_token: cpTokens[id] }) }))
      setEditing(false)
    } catch (err) {
      showAlert(translateApiError(err, t))
    }
  }

  const deletePointOwned = async () => {
    if (!(await showConfirm(t('collectionPoints.deletePointConfirm')))) return
    if (deleting) return
    setDeleting(true)
    try {
      await api(`/collection-points/${id}/`, { method: 'DELETE', body: JSON.stringify({ access_token: cpTokens[id] }) })
      removeCpToken(id)
      refreshConfig()
      navigate(cp.is_international ? '/international-collection-points' : '/collection-points', { replace: true })
    } catch (e) {
      showAlert(translateApiError(e, t))
    } finally {
      setDeleting(false)
    }
  }

  const deletePointByIdentity = async () => {
    // Same code-first, name+phone-fallback prompt sequence as
    // closePointByIdentity above.
    const code = await showPrompt(t('collectionPoints.closePromptCode'))
    if (code === null) return
    let payload
    if (code.trim()) {
      payload = { code: code.trim() }
    } else {
      const contact_name = await showPrompt(t('collectionPoints.closePromptName'))
      if (!contact_name) return
      const contact_phone = await showPrompt(t('collectionPoints.closePromptPhone'))
      payload = { contact_name, contact_phone }
    }
    if (!(await showConfirm(t('collectionPoints.deletePointConfirm')))) return
    try {
      await api(`/collection-points/${id}/`, { method: 'DELETE', body: JSON.stringify(payload) })
      navigate(cp.is_international ? '/international-collection-points' : '/collection-points', { replace: true })
    } catch (e) {
      showAlert(translateApiError(e, t))
    }
  }

  if (!cp) return null

  return (
    <section className="detail-page">
      <div className="detail-title-row">
        <h2>{cp.point_name}</h2>
        {/* Never offered for an international point -- couriers/drivers
            only ever operate in Algeria, and Pickup creation rejects one
            targeting this kind of point server-side regardless. */}
        {cp.status === 'active' && !cp.is_international && (
          <button className="btn btn-success" onClick={() => navigate(`/collection-points/${id}/take-charge`)}>
            {t('collectionPoints.takeChargeDelivery')}
          </button>
        )}
      </div>
      <span className="status">{t(`status.${cp.status}`)}</span>
      {cp.created_from_flyer && <p className="hint">{t('collectionPoints.createdFromFlyer')}</p>}
      <p>{cp.is_international ? cp.country_name : cp.wilaya_name}</p>
      <p>{cp.location_description}</p>
      {cp.latitude != null && cp.longitude != null ? (
        <p>
          {/* Uses the visitor's own position (prefetched in the background,
              see originRef above) as the directions' origin when it's
              already available, so Google Maps opens straight into
              turn-by-turn directions with both ends already known, instead
              of a bare destination pin that leaves Maps to resolve "your
              location" itself -- falls back to a destination-only link
              when it isn't (denied/timed out/not resolved yet), in which
              case Maps just asks for the origin the way it always did.
              Navigates the CURRENT tab (no window.open/target=_blank): a
              new tab opened for this consistently ended up stuck on
              "about:blank" on Android Chrome (confirmed live) instead of
              ever reaching Maps. The trade-off is this leaves the SOS DZ
              page (the phone's back button returns to it, same as any
              outbound link). Deliberately synchronous -- no await/.then()
              in the click handler itself, see originRef's own comment
              for why. */}
          <button
            type="button"
            className="link field-label-icon"
            onClick={() => {
              window.location.href = googleMapsDirectionsUrl(cp.latitude, cp.longitude, originRef.current)
            }}
          >
            <IconMapPin width={16} height={16} strokeWidth={2} /> {t('common.openInMaps')}
          </button>
        </p>
      ) : (
        <p className="hint">{t('common.noExactGpsPosition')}</p>
      )}
      {cp.organization && <p>{cp.organization}</p>}
      {cp.hours && <p>{t('collectionPoints.hours')}: {cp.hours}</p>}
      {cp.description && <p className="multiline-text">{cp.description}</p>}
      {cp.accepted_donations && (
        <p className="multiline-text">
          {t('collectionPoints.acceptedDonationsLabel')}: {cp.accepted_donations}
        </p>
      )}

      {(cp.flyer_image || cp.flyer_moderation_status !== 'approved') && (
        <div>
          <ModerationBadge t={t} status={cp.flyer_moderation_status} moderatedBy={cp.flyer_moderated_by} />
          {!cp.flyer_image && (
            <p className="hint">
              {t('needDetail.recordedMessage', {
                status: cp.flyer_moderation_status === 'rejected' ? t('needDetail.removedByModeration') : t('needDetail.pendingReview'),
              })}
            </p>
          )}
          {cp.flyer_image && (
            <div>
              {/* A capped-size preview (click to view full-size in the
                  lightbox), not the full-bleed .media-player treatment
                  meant for video/audio -- a poster image doesn't need to
                  take up to 70vh of the page by default. */}
              <button type="button" className="flyer-thumb-btn" onClick={() => setLightbox({ src: cp.flyer_image })}>
                <img className="flyer-thumb" src={cp.flyer_image} alt={t('common.flyerAlt')} />
              </button>
              <br />
              <button className="link" onClick={reportFlyer}>
                {t('needDetail.reportContent')}
              </button>
            </div>
          )}
        </div>
      )}
      <p>
        {t('needDetail.contact')}: {cp.contact_name} — {maskPhone(cp.contact_phone, showPhone)}{' '}
        <button className="link" onClick={() => setShowPhone(!showPhone)}>
          {showPhone ? t('common.hideNumber') : t('common.showFullNumber')}
        </button>
      </p>
      {/* other_phones is more personal contact info, same as contact_phone
          above -- kept behind the same reveal toggle instead of shown by
          default, rather than a separate always-visible field. */}
      {cp.other_phones && showPhone && (
        <p className="multiline-text">
          {t('collectionPoints.otherPhonesLabel')}: {cp.other_phones}
        </p>
      )}
      {isOwner ? (
        <div className="owner-actions">
          <h4>{t('collectionPoints.manageMyPoint')}</h4>
          {editing ? (
            <form onSubmit={saveEditOwned} className="inline-edit-form">
              <label>
                {t('collectionPoints.pointName')} <input type="text" value={editForm.point_name} onChange={setEditField('point_name')} />
              </label>
              <label>
                {t('collectionPoints.organization')} <input type="text" value={editForm.organization} onChange={setEditField('organization')} />
              </label>
              <label>
                {t('collectionPoints.locationDescription')}
                <textarea value={editForm.location_description} onChange={setEditField('location_description')} />
              </label>
              <label>
                {t('collectionPoints.hours')} <input type="text" value={editForm.hours} onChange={setEditField('hours')} />
              </label>
              <label>
                {t('collectionPoints.description')}
                <textarea value={editForm.description} onChange={setEditField('description')} />
              </label>
              <label>
                {t('collectionPoints.acceptedDonations')}
                <textarea value={editForm.accepted_donations} onChange={setEditField('accepted_donations')} />
              </label>
              <label>
                <span className="field-label-icon">
                  <IconFacebook width={18} height={18} strokeWidth={1.6} /> {t('collectionPoints.facebook')}
                </span>
                <input type="url" value={editForm.facebook_url} onChange={setEditField('facebook_url')} />
              </label>
              <label>
                <span className="field-label-icon">
                  <IconTikTok width={18} height={18} strokeWidth={1.6} /> {t('collectionPoints.tiktok')}
                </span>
                <input type="url" value={editForm.tiktok_url} onChange={setEditField('tiktok_url')} />
              </label>
              <label>
                <span className="field-label-icon">
                  <IconInstagram width={18} height={18} strokeWidth={1.6} /> {t('collectionPoints.instagram')}
                </span>
                <input type="url" value={editForm.instagram_url} onChange={setEditField('instagram_url')} />
              </label>
              <fieldset>
                <legend>{t('createNeed.contactDetailsLegend')}</legend>
                <label>
                  {t('collectionPoints.contactName')} <input type="text" value={editForm.contact_name} onChange={setEditField('contact_name')} />
                </label>
                <label>
                  {t('collectionPoints.contactPhone')} <input type="tel" value={editForm.contact_phone} onChange={setEditField('contact_phone')} />
                </label>
                <label>
                  {t('collectionPoints.otherPhones')}
                  <textarea value={editForm.other_phones} onChange={setEditField('other_phones')} />
                </label>
              </fieldset>
              <button type="submit" className="btn btn-primary">
                {t('common.save')}
              </button>
              <button type="button" className="btn" onClick={() => setEditing(false)}>
                {t('common.cancel')}
              </button>
            </form>
          ) : (
            <button className="btn" onClick={startEdit}>
              {t('common.edit')}
            </button>
          )}
          {cp.status === 'active' && (
            <button className="btn" onClick={closePointOwned}>
              {t('collectionPoints.markAsClosed')}
            </button>
          )}
          <button className="btn btn-danger" onClick={deletePointOwned} disabled={deleting}>
            {t('collectionPoints.deleteThisPoint')}
          </button>
        </div>
      ) : (
        <div>
          {cp.status === 'active' && (
            <button className="btn" onClick={closePointByIdentity}>
              {t('collectionPoints.markAsClosed')}
            </button>
          )}
          <button className="btn btn-danger" onClick={deletePointByIdentity}>
            {t('collectionPoints.deleteThisPoint')}
          </button>
          <br />
          <Link className="link" to="/recover" state={{ type: 'collection_point', id: cp.id }}>
            {t('collectionPoints.isThisYourPoint')}
          </Link>
        </div>
      )}

      {/* Always empty for an international point -- no take-charge ever
          possible, so this whole section (and its "(0)" count) is just
          noise there and is skipped entirely. */}
      {!cp.is_international && (
        <>
          {cp.status === 'active' && <h3>{t('needDetail.pickupsTitle', { count: cp.pickups.length })}</h3>}
          {cp.pickups.map((p) => (
            <PickupManager key={p.id} pickup={p} pickupToken={pickupTokens[p.id]} onChange={load} />
          ))}
        </>
      )}

      {SOCIAL_NETWORKS.some(({ field }) => isSafeHttpUrl(cp[field])) && (
        <div className="social-links-section">
          <h3>{t('collectionPoints.socialLinks')}</h3>
          <div className="social-links">
            {SOCIAL_NETWORKS.filter(({ field }) => isSafeHttpUrl(cp[field])).map(({ field, name, Icon }) => (
              <a
                key={field}
                href={cp[field]}
                target="_blank"
                rel="noopener noreferrer"
                className="social-link"
                aria-label={t('collectionPoints.visitSocial', { network: name })}
                title={t('collectionPoints.visitSocial', { network: name })}
              >
                <Icon width={22} height={22} />
              </a>
            ))}
          </div>
        </div>
      )}

      <CommentThread comments={cp.comments || []} target="collection_point" targetId={cp.id} onChanged={load} />

      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <button type="button" className="lightbox-close" onClick={() => setLightbox(null)} aria-label={t('needDetail.closeLightbox')}>
            ×
          </button>
          <img src={lightbox.src} alt={t('common.flyerAlt')} onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </section>
  )
}
