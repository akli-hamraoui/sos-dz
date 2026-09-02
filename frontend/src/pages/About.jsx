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
      {config.contact_phones.length > 0 && (
        <div className="whatsapp-contacts">
          <h3>{t('about.whatsappHeading')}</h3>
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
        </div>
      )}
      <p>
        <Link className="link" to="/support">
          {t('about.contactLink')}
        </Link>
      </p>
    </section>
  )
}
