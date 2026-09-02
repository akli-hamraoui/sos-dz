import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { useDialog } from '../context/DialogContext'
import { api } from '../api'
import { formatDate } from '../utils'

// Shared by NeedDetail and CollectionPointDetail -- comments only ever
// require a name (no phone), and deletion is authorized by a per-comment
// owner_token saved locally on creation (see AppContext.commentTokens),
// same pattern as Need/Pickup's access_token. A comment not created in
// this browser simply has no delete button, rather than prompting for
// credentials that no longer exist.
export default function CommentThread({ comments, target, targetId, onChanged }) {
  const { t, i18n } = useTranslation()
  const { commentAuthor, setCommentAuthor, commentTokens, saveCommentToken } = useApp()
  const { showPrompt, showConfirm } = useDialog()
  const [texts, setTexts] = useState({})

  const ensureAuthorName = async () => {
    if (commentAuthor.name) return commentAuthor.name
    const name = (await showPrompt(t('comments.namePrompt'))) || ''
    setCommentAuthor({ name })
    return name
  }

  const submit = async (parentId, key) => {
    const text = texts[key]
    if (!text) return
    const name = await ensureAuthorName()
    if (!name) return
    const payload = { author_name: name, text }
    payload[target] = targetId
    if (parentId) payload.parent_comment = parentId
    const created = await api('/comments/', { method: 'POST', body: JSON.stringify(payload) })
    saveCommentToken(created.id, created.owner_token)
    setTexts((p) => ({ ...p, [key]: '' }))
    onChanged()
  }

  const confirmComment = async (id) => {
    await api(`/comments/${id}/confirm/`, { method: 'POST' })
    onChanged()
  }

  const deleteComment = async (id) => {
    if (!(await showConfirm(t('common.delete') + '?'))) return
    await fetch(`/api/comments/${id}/`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner_token: commentTokens[id] }),
    })
    onChanged()
  }

  const renderMeta = (c) => (
    <p className="comment-meta">
      {c.author_name} — {formatDate(c.created_at, i18n.language)}
      {c.category && ` · ${t(`comments.category.${c.category}`)}`} ·{' '}
      <button className="link" onClick={() => confirmComment(c.id)}>
        {t('comments.confirmCount', { count: c.confirmation_count })}
      </button>
      {commentTokens[c.id] && (
        <>
          {' '}
          ·{' '}
          <button className="link" onClick={() => deleteComment(c.id)}>
            {t('common.delete')}
          </button>
        </>
      )}
    </p>
  )

  return (
    <div className="comment-thread">
      <h3>{t('comments.title')}</h3>
      {comments.map((c) => (
        <div key={c.id}>
          <div className="comment">
            <p>{c.text}</p>
            {renderMeta(c)}
            <div className="comment-form">
              <input
                type="text"
                value={texts[`reply-${c.id}`] || ''}
                onChange={(e) => setTexts((p) => ({ ...p, [`reply-${c.id}`]: e.target.value }))}
                placeholder={t('comments.replyPlaceholder')}
              />
              <button className="btn" onClick={() => submit(c.id, `reply-${c.id}`)}>
                {t('common.reply')}
              </button>
            </div>
          </div>
          {(c.replies || []).map((r) => (
            <div className="comment reply" key={r.id}>
              <p>{r.text}</p>
              {renderMeta(r)}
            </div>
          ))}
        </div>
      ))}
      <div className="comment-form">
        <input
          type="text"
          value={texts[`root-${target}-${targetId}`] || ''}
          onChange={(e) => setTexts((p) => ({ ...p, [`root-${target}-${targetId}`]: e.target.value }))}
          placeholder={t('comments.placeholder')}
        />
        <button className="btn btn-primary" onClick={() => submit(null, `root-${target}-${targetId}`)}>
          {t('common.post')}
        </button>
      </div>
    </div>
  )
}
