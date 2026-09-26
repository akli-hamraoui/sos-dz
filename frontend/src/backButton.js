import { useEffect, useRef } from 'react'

// The phone's back button (and the browser's) closes what's open on the
// page -- a panel, a photo, a dialog, the menu -- or goes back one step of
// a wizard, instead of leaving the page. Each of those pushes one history
// entry on the same URL (the router's own state kept, so the router sees
// no navigation); the back button pops it and the matching onBack runs.
// Closed from the page itself (✕, a button), its entry is taken back off.
//
// Signali's wizard keeps its steps in the URL's #hash instead (Signali.jsx).

const stack = [] // { id, onBack }, innermost last
let ignoredPops = 0

function onPopState() {
  if (ignoredPops > 0) {
    ignoredPops -= 1
    return
  }
  const top = stack[stack.length - 1]
  if (!top || window.history.state?.sosLayer === top.id) return
  stack.pop()
  top.onBack()
}
if (typeof window !== 'undefined') window.addEventListener('popstate', onPopState)

let nextId = 1
function pushLayer(onBack) {
  const id = `l${nextId++}`
  window.history.pushState({ ...window.history.state, sosLayer: id }, '')
  stack.push({ id, onBack })
  return id
}

// Closed by the page itself: their history entries go too (when still on
// top -- not after leaving for another page). `ids`: innermost first; one
// history.go() for all of them, history.back() being asynchronous.
function dropLayers(ids) {
  if (!ids.length) return
  ids.forEach((id) => {
    const i = stack.findIndex((x) => x.id === id)
    if (i !== -1) stack.splice(i, 1)
  })
  if (window.history.state?.sosLayer === ids[0]) {
    ignoredPops += 1
    window.history.go(-ids.length)
  }
}

// While `open`, the back button calls onBack (which should close it).
export function useBackLayer(open, onBack) {
  const onBackRef = useRef(onBack)
  useEffect(() => {
    onBackRef.current = onBack
  })
  useEffect(() => {
    if (!open) return
    let popped = false
    const id = pushLayer(() => {
      popped = true
      onBackRef.current()
    })
    return () => {
      if (!popped) dropLayers([id])
    }
  }, [open])
}

// A wizard at step `level` (0 = the first): one entry per step past the
// first, the back button calls onBack (which should go one step back).
export function useBackSteps(level, onBack) {
  const onBackRef = useRef(onBack)
  useEffect(() => {
    onBackRef.current = onBack
  })
  const idsRef = useRef([])
  useEffect(() => {
    const ids = idsRef.current
    while (ids.length < level) {
      const id = pushLayer(() => {
        ids.splice(ids.indexOf(id), 1)
        onBackRef.current()
      })
      ids.push(id)
    }
    const dropped = []
    while (ids.length > level) dropped.push(ids.pop())
    dropLayers(dropped)
  }, [level])
  useEffect(
    () => () => {
      // Leaving the page: forget the steps (their entries, if still on
      // top, are taken off like a UI close).
      const ids = idsRef.current
      dropLayers(ids.splice(0).reverse())
    },
    []
  )
}
