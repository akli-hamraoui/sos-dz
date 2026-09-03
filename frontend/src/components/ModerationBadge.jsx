// Shared moderation-status badge for any moderated image (damage photos,
// delivery photos, collection point flyers) -- previously duplicated
// locally in NeedDetail.jsx and CollectionPointDetail.jsx.
export default function ModerationBadge({ t, status, moderatedBy }) {
  let key = 'pending'
  if (status === 'approved') key = moderatedBy === 'admin' ? 'adminApproved' : 'systemApproved'
  else if (status === 'rejected') key = 'rejected'
  return <span className={`moderation-badge moderation-badge-${status === 'rejected' ? 'rejected' : status === 'approved' ? 'approved' : 'pending'}`}>{t(`needDetail.moderationBadge.${key}`)}</span>
}
