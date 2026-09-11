import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
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
    contact_phones: [],
    admin_contact_email: '',
    is_admin: false,
  })
  const [wilayas, setWilayas] = useState([])
  const [campaigns, setCampaigns] = useState([])
  const [needTokens, setNeedTokens] = useState(() => loadJSON('rassemble_need_tokens', {}))
  const [pickupTokens, setPickupTokens] = useState(() => loadJSON('rassemble_pickup_tokens', {}))
  const [cpTokens, setCpTokens] = useState(() => loadJSON('rassemble_cp_tokens', {}))
  const [commentTokens, setCommentTokens] = useState(() => loadJSON('rassemble_comment_tokens', {}))
  const [commentAuthor, setCommentAuthorState] = useState(() => loadJSON('rassemble_comment_author', { name: '' }))
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const [syncMessage, setSyncMessage] = useState('')
  const location = useLocation()

  const refreshConfig = useCallback(() => {
    return api('/config/')
      .then((data) => setConfig((prev) => ({ ...prev, ...data })))
      .catch(() => {})
  }, [])

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
    api('/translations/')
      .then((overrides) => {
        let changed = false
        for (const [locale, tree] of Object.entries(overrides)) {
          if (Object.keys(tree).length === 0) continue
          i18n.addResourceBundle(locale, 'translation', tree, true, true)
          changed = true
        }
        if (changed) i18n.changeLanguage(i18n.language)
      })
      .catch(() => {})
  }, [])

  // Refresh the public counters whenever navigation happens so the footer
  // SOS badge does not keep the value from the previous page. The backend
  // counter is the authoritative total of active/published needs and
  // includes needs with and without a geographic position.
  useEffect(() => {
    refreshConfig()
  }, [location.pathname, refreshConfig])

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
      try {
        saveJSON('rassemble_need_tokens', next)
      } catch (error) {
        console.error('[SOS] Impossible de sauvegarder le token du SOS dans le stockage local.', {
          needId,
          error,
        })
      }
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

  const saveCpToken = useCallback((cpId, token) => {
    setCpTokens((prev) => {
      const next = { ...prev, [cpId]: token }
      saveJSON('rassemble_cp_tokens', next)
      return next
    })
  }, [])

  const setCommentAuthor = useCallback((author) => {
    setCommentAuthorState(author)
    saveJSON('rassemble_comment_author', author)
  }, [])

  const saveCommentToken = useCallback((commentId, token) => {
    setCommentTokens((prev) => {
      const next = { ...prev, [commentId]: token }
      saveJSON('rassemble_comment_tokens', next)
      return next
    })
  }, [])

  const wilayasForCampaign = useCallback(
    (campaignId) => {
      const c = campaigns.find((c) => String(c.id) === String(campaignId))
      return c ? c.authorized_wilayas : wilayas
    },
    [campaigns, wilayas]
  )

  const activeCampaign = useMemo(() => campaigns.find((c) => c.status === 'active') || null, [campaigns])
  const activeCampaignWilayas = useMemo(() => (activeCampaign ? activeCampaign.authorized_wilayas : wilayas), [activeCampaign, wilayas])

  const value = {
    config,
    refreshConfig,
    wilayas,
    campaigns,
    wilayasForCampaign,
    activeCampaign,
    activeCampaignWilayas,
    needTokens,
    saveNeedToken,
    pickupTokens,
    savePickupToken,
    cpTokens,
    saveCpToken,
    commentAuthor,
    setCommentAuthor,
    commentTokens,
    saveCommentToken,
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
