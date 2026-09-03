import { useState, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { IconCheckCircle } from '../icons'

// Generic "Copier" -> "Copié ✓" button for any shareable URL/text in the
// app (courier tracking links, etc). Clipboard API when available (mobile
// Chrome/Safari included); falls back to a hidden-textarea + execCommand
// for non-secure contexts or older browsers where it isn't.
export default function CopyButton({ text, className = 'btn btn-icon' }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef(null)

  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard permission denied/unavailable -- button just stays
         "Copier", no crash and nothing else breaks */
    }
  }

  return (
    <button type="button" className={className} onClick={copy}>
      {copied ? (
        <>
          <IconCheckCircle width={16} height={16} strokeWidth={2} /> {t('common.copied')}
        </>
      ) : (
        t('common.copy')
      )}
    </button>
  )
}
