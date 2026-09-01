import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useApp } from '../context/AppContext'
import { api } from '../api'
import { maskPhone, formatDate } from '../utils'

const STATUSES = ['en_route', 'delivered', 'cancelled']

export default function Deliveries() {
  const { t, i18n } = useTranslation()
  const { activeCampaignWilayas } = useApp()
  const [filterWilaya, setFilterWilaya] = useState('')
  const [filterStatus, setFilterStatus] = useState('en_route')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [pickups, setPickups] = useState([])

  // Debounced so typing doesn't fire a request on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (filterWilaya) params.set('wilaya', filterWilaya)
    if (filterStatus) params.set('status', filterStatus)
    if (search) params.set('search', search)
    const qs = params.toString() ? `?${params.toString()}` : ''
    const data = await api(`/pickups/${qs}`)
    setPickups(data.results || data)
  }, [filterWilaya, filterStatus, search])

  useEffect(() => {
    load().catch(() => {}) // offline/network failure -- offline banner already informs the user
  }, [load])

  return (
    <section className="needs-page">
      <div className="toolbar">
        <input
          type="search"
          className="search-input"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('common.searchPlaceholder')}
        />
        <label>
          {t('needsList.filterByWilaya')}
          <select value={filterWilaya} onChange={(e) => setFilterWilaya(e.target.value)}>
            <option value="">{t('needsList.all')}</option>
            {activeCampaignWilayas.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('deliveries.filterByStatus')}
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
            <option value="">{t('deliveries.statusAll')}</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`status.${s}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {pickups.length === 0 && <p>{t('deliveries.noDeliveries')}</p>}
      <div className="needs-list">
        {pickups.map((p) => (
          <Link className="need-card" to={`/needs/${p.need}`} key={p.id}>
            <span className={`badge badge-status-${p.status}`}>{t(`status.${p.status}`)}</span>
            <h3>{p.need_title}</h3>
            <p>{p.need_wilaya_name}</p>
            {!p.is_anonymized && (
              <p className="status">
                {t('deliveries.responder')}: {p.organization_or_person_name || p.responder_name} —{' '}
                {maskPhone(p.responder_phone)}
              </p>
            )}
            {p.content_brought && (
              <p className="status">
                {t('deliveries.bringing')}: {p.content_brought}
              </p>
            )}
            <p className="status">
              {t('deliveries.since')} {formatDate(p.pickup_date, i18n.language)}
            </p>
          </Link>
        ))}
      </div>
    </section>
  )
}
