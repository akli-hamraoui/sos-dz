import { useTranslation } from 'react-i18next'

const GITHUB_URL = 'https://github.com/akli-hamraoui/sos-dz'
const CREATOR_NAME = 'Akli Hamraoui'
const CREATOR_EMAIL = 'hamraoui.akli@gmail.com'
const CGU_ARTICLE_COUNT = 6

export default function Legal() {
  const { t } = useTranslation()
  return (
    <section className="form-page legal-page">
      <h2>{t('legal.title')}</h2>

      <h3>{t('legal.editor.title')}</h3>
      <p>
        {t('legal.editor.p1')} <strong>{CREATOR_NAME}</strong>.
      </p>
      <p>
        {t('legal.editor.contact')} <a href={`mailto:${CREATOR_EMAIL}`}>{CREATOR_EMAIL}</a>
      </p>

      <h3>{t('legal.project.title')}</h3>
      <p>{t('legal.project.p1')}</p>
      <p>{t('legal.project.p2')}</p>

      <h3>{t('legal.openSource.title')}</h3>
      <p>
        {t('legal.openSource.p1')}{' '}
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
          {GITHUB_URL}
        </a>
      </p>
      <p>{t('legal.openSource.p2')}</p>

      <h3>{t('legal.hosting.title')}</h3>
      <ul>
        <li>{t('legal.hosting.provider')}</li>
        <li>{t('legal.hosting.country')}</li>
        <li>{t('legal.hosting.domain')}</li>
        <li>{t('legal.hosting.registrar')}</li>
      </ul>

      <h3>{t('legal.cgu.title')}</h3>
      <p>{t('legal.cgu.intro')}</p>
      {Array.from({ length: CGU_ARTICLE_COUNT }, (_, i) => i + 1).map((n) => (
        <div key={n}>
          <h4>{t(`legal.cgu.article${n}Title`)}</h4>
          <p>{t(`legal.cgu.article${n}Body`)}</p>
        </div>
      ))}

      <h3>{t('legal.cgv.title')}</h3>
      <p>{t('legal.cgv.body')}</p>

      <h3>{t('legal.solidarity.title')}</h3>
      <p>{t('legal.solidarity.p1')}</p>
      <p>{t('legal.solidarity.p2')}</p>
      <p>
        {t('legal.solidarity.contact')} <a href={`mailto:${CREATOR_EMAIL}`}>{CREATOR_EMAIL}</a>
      </p>
    </section>
  )
}
