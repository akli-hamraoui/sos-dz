// Wave 5 offline-first queue: creating a Need, a Pickup, or a ProgressUpdate
// while offline gets queued in IndexedDB and synced automatically once the
// connection returns (spec: "a basic in-memory/local retry should already
// exist [Wave 2] ... full offline queue built properly in Wave 5").
//
// Records store plain field values plus any File/Blob objects separately
// (structured-clone supports Blob/File natively in IndexedDB, but not
// FormData itself) so a FormData can be reconstructed at sync time.
//
// Simple dependency resolution: a queued Pickup or ProgressUpdate created
// against a Need/Pickup that was ALSO created offline (and hasn't synced
// yet) references it by a local negative id; once the parent syncs, its
// real id is substituted into any dependents before they're sent.

import { openDB } from 'idb'

const DB_NAME = 'rassemble-offline'
const STORE = 'queue'

let nextLocalId = -1

async function getDB() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE, { keyPath: 'localId' })
    },
  })
}

// type: 'need' | 'pickup' | 'progress_update'
// fields: plain JSON-serializable object of form fields
// files: { fieldName: File | File[] }
// dependsOnField / dependsOnLocalId: for a pickup/progress_update created
// against a not-yet-synced local Need/Pickup, e.g. dependsOnField: 'need'
export async function enqueue({ type, endpoint, fields, files = {}, dependsOnField = null, dependsOnLocalId = null }) {
  const db = await getDB()
  const localId = nextLocalId--
  const record = {
    localId,
    type,
    endpoint,
    fields,
    files,
    dependsOnField,
    dependsOnLocalId,
    queuedAt: new Date().toISOString(),
    status: 'pending',
  }
  await db.put(STORE, record)
  return record
}

export async function getQueue() {
  const db = await getDB()
  return db.getAll(STORE)
}

export async function removeFromQueue(localId) {
  const db = await getDB()
  await db.delete(STORE, localId)
}

function buildFormData(fields, files) {
  const fd = new FormData()
  Object.entries(fields).forEach(([k, v]) => {
    if (v !== null && v !== undefined && v !== '') fd.append(k, v)
  })
  Object.entries(files).forEach(([k, v]) => {
    const list = Array.isArray(v) ? v : [v]
    list.forEach((file) => fd.append(k, file, file.name || 'upload'))
  })
  return fd
}

// Attempts to sync every queued record, in insertion order, resolving
// simple local-id dependencies as parents succeed. Returns
// { synced: [...localIds], failed: [...localIds] }.
export async function syncQueue() {
  const db = await getDB()
  const all = (await db.getAll(STORE)).sort((a, b) => a.localId - b.localId)
  const idMap = {} // localId (negative) -> real server id
  const synced = []
  const failed = []

  for (const record of all) {
    if (record.dependsOnLocalId != null && !(record.dependsOnLocalId in idMap)) {
      failed.push(record.localId) // parent hasn't synced yet, try again next pass
      continue
    }
    const fields = { ...record.fields }
    if (record.dependsOnField && record.dependsOnLocalId != null) {
      fields[record.dependsOnField] = idMap[record.dependsOnLocalId]
    }
    try {
      const resp = await fetch(record.endpoint, { method: 'POST', body: buildFormData(fields, record.files) })
      if (!resp.ok) throw new Error(`Sync failed: ${resp.status}`)
      const data = await resp.json()
      idMap[record.localId] = data.id
      await db.delete(STORE, record.localId)
      synced.push({ localId: record.localId, serverId: data.id, type: record.type, data })
    } catch (e) {
      failed.push(record.localId)
    }
  }
  return { synced, failed }
}

export function setupAutoSync(onSynced) {
  const trySync = async () => {
    if (!navigator.onLine) return
    const result = await syncQueue()
    if (result.synced.length && onSynced) onSynced(result)
  }
  window.addEventListener('online', trySync)
  trySync()
  const interval = setInterval(trySync, 30000)
  return () => {
    window.removeEventListener('online', trySync)
    clearInterval(interval)
  }
}
