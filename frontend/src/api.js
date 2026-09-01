import { enqueue } from './offlineQueue'

const API = '/api'

export function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}
export function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

// Django only sets this cookie once a session exists (e.g. an admin who is
// also browsing the public site in the same browser). For an ordinary
// anonymous visitor there is no cookie, so this is a no-op -- but when it
// is present it must be sent back or Django's CSRF middleware rejects the
// request even though CORS/origin are otherwise fine.
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

const UNSAFE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

function withCsrfHeader(method, headers) {
  const upperMethod = (method || 'GET').toUpperCase()
  if (!UNSAFE_METHODS.includes(upperMethod)) return headers
  const token = getCsrfToken()
  return token ? { ...headers, 'X-CSRFToken': token } : headers
}

export async function api(path, options = {}) {
  const resp = await fetch(API + path, {
    ...options,
    headers: withCsrfHeader(options.method, { 'Content-Type': 'application/json', ...(options.headers || {}) }),
  })
  let data = null
  try {
    data = await resp.json()
  } catch {
    /* no body */
  }
  if (!resp.ok) {
    const err = new Error((data && data.detail) || 'Request failed')
    err.status = resp.status
    err.data = data
    throw err
  }
  return data
}

const RETRY_DELAYS_MS = [1000, 3000, 6000]

// Upload retry (Wave 2): 3 attempts with increasing delay on network
// failure or 5xx, never on a 4xx validation error. `url` is an absolute
// path (e.g. "/api/needs/") -- callers decide the prefix, this never adds
// one, so it's usable both from apiUpload() (relative app paths) and from
// createOrQueue()/offlineQueue.js (which already store full "/api/..."
// endpoints, since the offline queue's own sync has no access to the API
// prefix constant without a circular import).
async function uploadWithRetry(url, formData, method = 'POST', onStatus = () => {}) {
  let lastError = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      onStatus(`Retrying upload (${attempt}/${RETRY_DELAYS_MS.length})...`)
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]))
    }
    try {
      const resp = await fetch(url, { method, body: formData, headers: withCsrfHeader(method, {}) })
      let data = null
      try {
        data = await resp.json()
      } catch {
        /* no body */
      }
      if (resp.ok) {
        onStatus('')
        return data
      }
      if (resp.status < 500) {
        const err = new Error((data && data.detail) || 'Request failed')
        err.status = resp.status
        err.data = data
        throw err
      }
      lastError = new Error((data && data.detail) || `Server error (${resp.status})`)
    } catch (e) {
      if (e.status && e.status < 500) throw e
      lastError = e
    }
  }
  onStatus('Upload failed after several attempts.')
  throw lastError
}

export async function apiUpload(path, formData, method = 'POST', onStatus = () => {}) {
  return uploadWithRetry(API + path, formData, method, onStatus)
}

// Wave 5: offline-aware creation for Need/Pickup/ProgressUpdate. If the
// device is offline (or the request fails with a network error), the
// creation is queued in IndexedDB instead of failing, and synced
// automatically once connectivity returns (see offlineQueue.js).
export async function createOrQueue({ type, endpoint, fields, files = {}, dependsOnField = null, dependsOnLocalId = null, onStatus = () => {} }) {
  if (navigator.onLine) {
    try {
      const formData = new FormData()
      Object.entries(fields).forEach(([k, v]) => {
        if (v !== null && v !== undefined && v !== '') formData.append(k, v)
      })
      Object.entries(files).forEach(([k, v]) => {
        ;(Array.isArray(v) ? v : [v]).forEach((f) => formData.append(k, f, f.name || 'upload'))
      })
      const data = await uploadWithRetry(endpoint, formData, 'POST', onStatus)
      return { queued: false, data }
    } catch (e) {
      if (e.status) throw e // real validation error -- don't silently queue a request the server will just reject again
      // network error despite navigator.onLine -- fall through to queueing
    }
  }
  const record = await enqueue({ type, endpoint, fields, files, dependsOnField, dependsOnLocalId })
  return { queued: true, localId: record.localId }
}
