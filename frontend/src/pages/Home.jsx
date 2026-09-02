import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export default function Home() {
  const { t } = useTranslation()
  return (
    <section className="home">
      <p>{t('home.tagline')}</p>
      <div className="home-actions">
        <Link to="/create" className="btn btn-primary btn-huge">
          {t('home.iNeedHelp')}
        </Link>
        <Link to="/needs" className="btn btn-huge">
          {t('home.iWantToHelp')}
        </Link>
      </div>
    </section>
  )
}
