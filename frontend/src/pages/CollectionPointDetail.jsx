import { useState, useEffect, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api } from '../api'
import { maskPhone, formatDate } from '../utils'

function CommentThread({ comments, targetId, onChanged }) {
  const { t, i18n } = useTranslation()
  const [texts, setTexts] = useState({})
  const [author, setAuthor] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('rassemble_comment_author')) || { name: '', phone: '' }
    } catch {
      return { name: '', phone: '' }
    }
  })

  const ensureAuthor = () => {
    if (author.name && author.phone) return author
    const name = prompt(t('createNeed.name') + ':') || ''
    const phone = prompt(t('createNeed.phone') + ':') || ''
    const a = { name, phone }
    setAuthor(a)
    localStorage.setItem('rassemble_comment_author', JSON.stringify(a))
    return a
  }

  const submit = async (parentId, key) => {
    const text = texts[key]
    if (!text) return
    const a = ensureAuthor()
    const payload = { collection_point: targetId, author_name: a.name, author_phone: a.phone, text }
    if (parentId) payload.parent_comment = parentId
    await api('/comments/', { method: 'POST', body: JSON.stringify(payload) })
    setTexts((p) => ({ ...p, [key]: '' }))
    onChanged()
  }

  const confirmComment = async (id) => {
    await api(`/comments/${id}/confirm/`, { method: 'POST' })
    onChanged()
  }

  const deleteComment = async (id) => {
    if (!confirm(t('common.delete') + '?')) return
    await fetch(`/api/comments/${id}/`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author_name: author.name, author_phone: author.phone }),
    })
    onChanged()
  }

  return (
    <div className="comment-thread">
      <h3>{t('comments.title')}</h3>
      {comments.map((c) => (
        <div key={c.id}>
          <div className="comment">
            <p>{c.text}</p>
            <p className="comment-meta">
              {c.author_name} — {formatDate(c.created_at, i18n.language)} ·{' '}
              <button className="link" onClick={() => confirmComment(c.id)}>
                {t('comments.confirmCount', { count: c.confirmation_count })}
              </button>{' '}
              · <button className="link" onClick={() => deleteComment(c.id)}>{t('common.delete')}</button>
            </p>
            <div className="comment-form">
              <input type="text" value={texts[`reply-${c.id}`] || ''} onChange={(e) => setTexts((p) => ({ ...p, [`reply-${c.id}`]: e.target.value }))} placeholder={t('comments.replyPlaceholder')} />
              <button className="btn" onClick={() => submit(c.id, `reply-${c.id}`)}>
                {t('common.reply')}
              </button>
            </div>
          </div>
          {(c.replies || []).map((r) => (
            <div className="comment reply" key={r.id}>
              <p>{r.text}</p>
              <p className="comment-meta">
                {r.author_name} — {formatDate(r.created_at, i18n.language)} ·{' '}
                <button className="link" onClick={() => confirmComment(r.id)}>
                  {t('comments.confirmCount', { count: r.confirmation_count })}
                </button>{' '}
                · <button className="link" onClick={() => deleteComment(r.id)}>{t('common.delete')}</button>
              </p>
            </div>
          ))}
        </div>
      ))}
      <div className="comment-form">
        <input type="text" value={texts[`root-${targetId}`] || ''} onChange={(e) => setTexts((p) => ({ ...p, [`root-${targetId}`]: e.target.value }))} placeholder={t('comments.placeholder')} />
        <button className="btn btn-primary" onClick={() => submit(null, `root-${targetId}`)}>
          {t('common.post')}
        </button>
      </div>
    </div>
  )
}

export default function CollectionPointDetail() {
  const { t } = useTranslation()
  const { id } = useParams()
  const [cp, setCp] = useState(null)
  const [showPhone, setShowPhone] = useState(false)

  const load = useCallback(async () => {
    setCp(await api(`/collection-points/${id}/`))
  }, [id])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  const closePoint = async () => {
    const contact_name = prompt(t('collectionPoints.closePromptName'))
    if (!contact_name) return
    const contact_phone = prompt(t('collectionPoints.closePromptPhone'))
    try {
      setCp(await api(`/collection-points/${id}/close/`, { method: 'POST', body: JSON.stringify({ contact_name, contact_phone }) }))
    } catch (e) {
      alert(e.message)
    }
  }

  if (!cp) return null

  return (
    <section className="detail-page">
      <h2>{cp.point_name}</h2>
      <span className="status">{t(`status.${cp.status}`)}</span>
      <p>{cp.wilaya_name}</p>
      <p>{cp.location_description}</p>
      {cp.latitude == null && <p className="hint">{t('common.noExactGpsPosition')}</p>}
      {cp.organization && <p>{cp.organization}</p>}
      {cp.hours && <p>{t('collectionPoints.hours')}: {cp.hours}</p>}
      <p>
        {t('needDetail.contact')}: {cp.contact_name} — {maskPhone(cp.contact_phone, showPhone)}{' '}
        <button className="link" onClick={() => setShowPhone(!showPhone)}>
          {showPhone ? t('common.hideNumber') : t('common.showFullNumber')}
        </button>
      </p>
      {cp.status === 'active' && (
        <button className="btn" onClick={closePoint}>
          {t('collectionPoints.markAsClosed')}
        </button>
      )}

      <CommentThread comments={cp.comments || []} targetId={cp.id} onChanged={load} />
    </section>
  )
}
