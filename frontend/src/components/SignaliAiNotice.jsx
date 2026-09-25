import { useTranslation } from 'react-i18next'
import { IconMegaphone, IconSparkle } from '../icons'

// "Sent -- the AI is checking it, it'll be on the map shortly": one short
// line with the same kind of looping animation as the SOS pins (pulsing
// rings), twinkling sparkles and a scanning line. Shown on the report
// page while it's being processed.
export default function SignaliAiNotice({ sent = false }) {
  const { t } = useTranslation()
  return (
    <div className="signali-ai is-compact" role="status">
      <div className="signali-ai-anim" aria-hidden="true">
        <span className="signali-ai-ring" />
        <span className="signali-ai-ring signali-ai-ring-2" />
        <span className="signali-ai-core">
          <IconMegaphone width={26} height={26} strokeWidth={2} />
          <span className="signali-ai-scan" />
        </span>
        <span className="signali-ai-spark signali-ai-spark-1"><IconSparkle width={14} height={14} /></span>
        <span className="signali-ai-spark signali-ai-spark-2"><IconSparkle width={10} height={10} /></span>
        <span className="signali-ai-spark signali-ai-spark-3"><IconSparkle width={12} height={12} /></span>
      </div>
      <div className="signali-ai-copy">
        <strong>
          {sent ? `✓ ${t('signali.aiSentTitle')}` : `✨ ${t('signali.aiTitle')}`}
          <span className="signali-ai-dots" aria-hidden="true"><i /><i /><i /></span>
        </strong>
        <span>{t('signali.aiText')}</span>
      </div>
    </div>
  )
}
