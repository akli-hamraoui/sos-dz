import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api } from '../api'

export default function CollectionPoints() {
  const { t } = useTranslation()
  const { wilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [points, setPoints] = useState([])

  const load = useCallback(async () => {
    const qs = filterWilaya ? `?wilaya=${filterWilaya}` : ''
    const data = await api(`/collection-points/${qs}`)
    setPoints(data.results || data)
  }, [filterWilaya])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  return (
    <section className="needs-page">
      <div className="toolbar">
        <label>
          {t('needsList.filterByWilaya')}
          <select value={filterWilaya} onChange={(e) => setFilterWilaya(e.target.value)}>
            <option value="">{t('needsList.all')}</option>
            {wilayas.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <Link className="btn btn-primary" to="/collection-points/create">
          {t('collectionPoints.addButton')}
        </Link>
      </div>
      {points.length === 0 && <p>{t('collectionPoints.noPointsYet')}</p>}
      <div className="needs-list">
        {points.map((cp) => (
          <Link className="need-card" to={`/collection-points/${cp.id}`} key={cp.id}>
            <h3>{cp.point_name}</h3>
            <p>
              {cp.wilaya_name}
              {cp.organization ? ' — ' + cp.organization : ''}
            </p>
            <p className="status">{cp.status === 'closed' ? t('status.closed') : cp.hours || t('collectionPoints.hoursNotSpecified')}</p>
          </Link>
        ))}
      </div>
    </section>
  )
}
