// Backend validation/authorization errors are written in English source
// text (Django/DRF has no i18n wired up here) -- this maps every known
// message to the frontend's own fr/en/ar strings (see locales/*.json,
// "apiErrors" namespace) instead of showing raw English or a JSON dump to
// a French/Arabic-speaking visitor. Matches are either an exact string or
// a regex for messages with a dynamic value embedded (a duration, a
// throttle wait time...); anything unmatched falls back to a clean
// generic translated message -- never raw text.
const MATCHERS = [
  { match: 'This need has been cancelled.', key: 'needCancelled' },
  { match: 'This campaign is not accepting new pickups right now.', key: 'campaignNotAcceptingPickups' },
  { match: 'This campaign is not accepting new needs right now (paused or stopped).', key: 'campaignNotAcceptingNeeds' },
  { match: 'This wilaya is not authorized for the selected campaign.', key: 'wilayaNotAuthorized' },
  { match: 'Please provide at least one of: a text description, a voice message, or a video.', key: 'needAtLeastOneMedia' },
  { match: 'Provide either a code, or both name and phone.', key: 'provideCodeOrIdentity' },
  { match: 'Please provide at least one of: your phone number or your email, so the admin can follow up.', key: 'supportContactMethodRequired' },
  { match: "Exactly one of 'need' or 'collection_point' must be set.", key: 'commentTargetInvalid' },
  { match: 'Replies cannot themselves be replied to (one level of nesting only).', key: 'commentReplyTooDeep' },
  { match: 'These coordinates fall outside Algeria and were rejected. Please use the wilaya + description fields instead.', key: 'coordinatesOutsideAlgeria' },
  { match: 'The recovery code must be at least 6 characters long.', key: 'recoveryCodeTooShort' },
  { match: 'This recovery code is already in use. Please choose a different one.', key: 'recoveryCodeTaken' },
  { match: 'The app is currently in read-only mode. Existing data remains viewable.', key: 'readOnlyMode' },
  { match: 'Only visible from within Algeria can create or edit listings — you can still browse everything.', key: 'geoRestricted' },
  { match: 'Please complete the anti-spam check before submitting.', key: 'captchaRequired' },
  { match: 'Anti-spam check failed, please try again.', key: 'captchaFailed' },
  { match: 'Could not verify the anti-spam check right now, please try again.', key: 'captchaUnavailable' },
  { match: 'This listing has been anonymized and is frozen from further edits.', key: 'listingAnonymizedFrozen' },
  { match: "Not authorized: this access token doesn't match this need.", key: 'notAuthorizedToken' },
  { match: "Not authorized: this access token doesn't match this pickup.", key: 'notAuthorizedToken' },
  { match: "Not authorized to view this need's live location.", key: 'notAuthorizedLiveLocation' },
  { match: 'Not authorized.', key: 'notAuthorizedGeneric' },
  { match: 'This listing has been anonymized; access can no longer be recovered.', key: 'listingAnonymizedNoRecover' },
  { match: 'No match. If this keeps happening, use the support/contact-admin form.', key: 'recoveryNoMatch' },
  {
    match: 'This listing is still active. Your contact details will be removed, others will no longer be able to reach you about this. Confirm to proceed.',
    key: 'needAnonymizeConfirm',
  },
  {
    match: 'This pickup is still active. Your contact details will be removed, others will no longer be able to reach you about this. Confirm to proceed.',
    key: 'pickupAnonymizeConfirm',
  },
  { match: 'Not authorized: only the volunteer who owns this pickup can post updates.', key: 'notAuthorizedPickupUpdates' },
  { match: "Not authorized: only this pickup's own volunteer can submit its position.", key: 'notAuthorizedPickupPosition' },
  { match: "Name/phone don't match this collection point's contact.", key: 'nameDontMatchCollectionPoint' },
  { match: 'Not authorized to delete this comment.', key: 'notAuthorizedDeleteComment' },
  {
    match: "Video duration could not be verified server-side, so it can't be accepted. Please try again, or contact support if this persists.",
    key: 'videoDurationUnverifiable',
  },
  { match: 'Maximum 3 photos allowed.', key: 'tooManyPhotos' },
  { match: /^Photo exceeds the maximum size of (\d+)MB\.$/, key: 'photoTooLarge', params: (m) => ({ max: m[1] }) },
  { match: /^Video exceeds the maximum size of (\d+)MB\.$/, key: 'videoTooLarge', params: (m) => ({ max: m[1] }) },
  { match: 'Too many submissions from this connection. Please try again later.', key: 'rateLimitedGeneric' },
  {
    match: /^Too many submissions from this connection\. Please wait about (\d+) minute\(s\) and try again\.$/,
    key: 'rateLimitedWithWait',
    params: (m) => ({ minutes: m[1] }),
  },
  { match: /^Video is (\d+)s long, the maximum is (\d+)s\.$/, key: 'videoTooLong', params: (m) => ({ duration: m[1], max: m[2] }) },
  { match: 'This field is required.', key: 'genericFieldError' },
  { match: 'This field may not be blank.', key: 'genericFieldError' },
  { match: 'This field may not be null.', key: 'genericFieldError' },
]

function translateOneMessage(raw, t) {
  for (const m of MATCHERS) {
    if (typeof m.match === 'string') {
      if (raw === m.match) return t(`apiErrors.${m.key}`)
    } else {
      const result = m.match.exec(raw)
      if (result) return t(`apiErrors.${m.key}`, m.params ? m.params(result) : undefined)
    }
  }
  return null
}

// err: the Error thrown by api()/apiUpload() (err.data is the parsed JSON
// body, err.message defaults to err.data.detail when present -- see
// api.js). Always returns a translated, human-readable string, never raw
// English or a JSON dump.
export function translateApiError(err, t) {
  if (!err) return t('apiErrors.generic')
  // A request rejected purely for its size (Nginx's client_max_body_size,
  // or Django's DATA_UPLOAD_MAX_MEMORY_SIZE) never reaches this app's own
  // validation, so there's no JSON body/known message to match against --
  // just Nginx's or gunicorn's own plain HTML error page. Handle it by
  // status code instead of by message so it still gets an explicit,
  // translated explanation rather than the generic fallback.
  if (err.status === 413) return t('apiErrors.payloadTooLarge')
  const data = err.data
  const rawMessages = []
  if (data && typeof data === 'object') {
    if (typeof data.detail === 'string') {
      rawMessages.push(data.detail)
    } else {
      for (const value of Object.values(data)) {
        if (Array.isArray(value)) rawMessages.push(...value.filter((v) => typeof v === 'string'))
        else if (typeof value === 'string') rawMessages.push(value)
      }
    }
  }
  if (!rawMessages.length) return t('apiErrors.generic')
  const translated = rawMessages.map((raw) => translateOneMessage(raw, t) || t('apiErrors.generic'))
  // De-duplicate so several unmapped field errors don't repeat the same
  // generic sentence back to back.
  return [...new Set(translated)].join(' ')
}
