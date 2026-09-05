import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { whatsappLink } from '../utils'

export default function About() {
  const { t } = useTranslation()
  const { config } = useApp()
  return (
    <section className="form-page">
      <h2>{t('about.title')}</h2>
      <p>{t('about.p1')}</p>
      <p>{t('about.p2')}</p>
      <p>{t('about.p3')}</p>
      <p>{t('about.p4')}</p>
      {/* Always shown, even with nothing configured yet -- an admin who
          hasn't set up AdminContactPhone entries in Django Admin should
          still see that WhatsApp exists as a channel (with a "coming
          soon" placeholder) rather than the whole section silently
          vanishing, which read as "WhatsApp isn't a thing this app has". */}
      <div className="whatsapp-contacts">
        <h3>{t('about.whatsappHeading')}</h3>
        {config.contact_phones.length > 0 ? (
          <ul>
            {config.contact_phones.map((p, i) => (
              <li key={i}>
                <a href={whatsappLink(p.phone)} target="_blank" rel="noopener noreferrer" className="btn whatsapp-btn">
                  {p.phone}
                  {p.label ? ` (${p.label})` : ''}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{t('about.whatsappComingSoon')}</p>
        )}
      </div>
      <p>
        <Link className="link" to="/support">
          {t('about.contactLink')}
        </Link>
      </p>
    </section>
  )
}
