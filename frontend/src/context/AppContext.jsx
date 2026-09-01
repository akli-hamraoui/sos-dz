import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { api, loadJSON, saveJSON } from '../api'
import { setupAutoSync } from '../offlineQueue'
import i18n from '../i18n'

const AppContext = createContext(null)

export function AppProvider({ children }) {
  const [config, setConfig] = useState({
    mode: 'normal',
    media_moderation_active: true,
    turnstile_enabled: false,
    turnstile_site_key: '',
    admin_contact_phone: '',
    admin_contact_email: '',
  })
  const [wilayas, setWilayas] = useState([])
  const [campaigns, setCampaigns] = useState([])
  const [needTokens, setNeedTokens] = useState(() => loadJSON('rassemble_need_tokens', {}))
  const [pickupTokens, setPickupTokens] = useState(() => loadJSON('rassemble_pickup_tokens', {}))
  const [commentAuthor, setCommentAuthorState] = useState(() => loadJSON('rassemble_comment_author', { name: '', phone: '' }))
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [syncMessage, setSyncMessage] = useState('')

  useEffect(() => {
    api('/config/')
      .then((data) => {
        setConfig(data)
        if (data.turnstile_enabled && !document.getElementById('turnstile-script')) {
          const s = document.createElement('script')
          s.id = 'turnstile-script'
          s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js'
          s.async = true
          s.defer = true
          document.head.appendChild(s)
        }
      })
      .catch(() => {})
    api('/wilayas/')
      .then((d) => setWilayas(d.results || d))
      .catch(() => {})
    api('/campaigns/')
      .then((d) => setCampaigns(d.results || d))
      .catch(() => {})
    // Admin-entered text corrections (Django Admin), merged over the
    // static locale JSON bundles -- lets a wrong/outdated string be fixed
    // without a frontend deploy. Missing entirely (network/API failure)
    // just means the static bundles are used as-is, same as before this
    // existed.
    api('/translations/')
      .then((overrides) => {
        let changed = false
        for (const [locale, tree] of Object.entries(overrides)) {
          if (Object.keys(tree).length === 0) continue
          i18n.addResourceBundle(locale, 'translation', tree, true, true)
          changed = true
        }
        if (changed) i18n.changeLanguage(i18n.language) // re-render components bound via useTranslation
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    const stopSync = setupAutoSync((result) => {
      setSyncMessage(result.synced.length === 1 ? 'syncedOne' : 'syncedMany')
      setTimeout(() => setSyncMessage(''), 6000)
    })
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      stopSync()
    }
  }, [])

  const saveNeedToken = useCallback((needId, tokenData) => {
    setNeedTokens((prev) => {
      const next = { ...prev, [needId]: { ...(prev[needId] || {}), ...tokenData } }
      saveJSON('rassemble_need_tokens', next)
      return next
    })
  }, [])

  const savePickupToken = useCallback((pickupId, token) => {
    setPickupTokens((prev) => {
      const next = { ...prev, [pickupId]: token }
      saveJSON('rassemble_pickup_tokens', next)
      return next
    })
  }, [])

  const setCommentAuthor = useCallback((author) => {
    setCommentAuthorState(author)
    saveJSON('rassemble_comment_author', author)
  }, [])

  const wilayasForCampaign = useCallback(
    (campaignId) => {
      const c = campaigns.find((c) => String(c.id) === String(campaignId))
      return c ? c.authorized_wilayas : wilayas
    },
    [campaigns, wilayas]
  )

  const value = {
    config,
    wilayas,
    campaigns,
    wilayasForCampaign,
    needTokens,
    saveNeedToken,
    pickupTokens,
    savePickupToken,
    commentAuthor,
    setCommentAuthor,
    isOnline,
    syncMessage,
  }

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useApp must be used within AppProvider')
  return ctx
}
