import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { HelmetProvider } from 'react-helmet-async'
import './index.css'
import './footer-sos-fixes.css'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './sos-map-marker.css'
import './sos-map-marker-fix.css'
// leaflet-gesture-handling is an old-style Leaflet plugin: it patches the
// global `L.Map` (via L.Map.addInitHook) and expects a global `window.L`
// to already exist, rather than importing leaflet itself -- since this
// app uses `import L from 'leaflet'` everywhere (no global), it must be
// exposed explicitly here before the plugin loads, or the whole app
// crashes at startup with "L is not defined".
window.L = L
// Every marker popup app-wide (see mapMarkers.js and each map page's own
// bindPopup calls) is a plain HTML string with <br>-separated fields --
// Leaflet's default maxWidth (300px) leaves almost no room to auto-pan on
// a narrow phone screen once a marker sits near the map container's own
// edge (a Europe-wide map's westernmost point, a marker near the screen's
// left border, etc.), so the popup's left side can render running off the
// visible viewport entirely -- confirmed live: reported as an unreadable,
// cut-off popup. A smaller maxWidth keeps every popup narrow enough to
// fit regardless of where its marker sits.
L.Popup.mergeOptions({
  maxWidth: 280,
  maxHeight: null,
  className: 'sosdz-map-popup',
  autoPan: false,
  keepInView: false,
})
import 'leaflet-gesture-handling'
import 'leaflet-gesture-handling/dist/leaflet-gesture-handling.css'
import './i18n'
import App from './App.jsx'
import { AppProvider } from './context/AppContext.jsx'
import { DialogProvider } from './context/DialogContext.jsx'

// The "sans localisation" SOS indicator belongs in the Needs toolbar, not
// on the map. The map already creates the real grouped marker with the
// authoritative count; mirror that control into the toolbar so the count
// stays in sync without duplicating API/state logic in another component.
function installUnlocatedSosToolbar() {
  const sync = () => {
    const toolbar = document.querySelector('.needs-page .toolbar-compact')
    const viewToggle = toolbar?.querySelector('.view-toggle')
    const source = document.querySelector('.need-marker-pin-unlocated')
    const existing = toolbar?.querySelector('.unlocated-sos-toolbar')
    const listFallbackCount = toolbar?.closest('.needs-page')?.querySelectorAll('.need-card .hint').length || 0

    if (!toolbar || !viewToggle) {
      existing?.remove()
      return
    }

    const count = source?.querySelector('.need-marker-count-badge')?.textContent?.trim() || (listFallbackCount ? String(listFallbackCount) : '')
    if (!count) {
      existing?.remove()
      return
    }

    let control = existing
    if (!control) {
      control = document.createElement('button')
      control.type = 'button'
      control.className = 'unlocated-sos-toolbar'
      control.setAttribute('aria-label', 'Besoins sans position')
      control.innerHTML = '<img src="/icons/need-marker-sos.png" alt="" aria-hidden="true"><span class="unlocated-sos-toolbar-count"></span>'
      control.addEventListener('click', () => {
        document.querySelector('.need-marker-pin-unlocated')?.closest('.leaflet-marker-icon')?.click()
        const filterButton = document.querySelector('.needs-page .filters-toggle')
        if (!document.querySelector('.need-marker-pin-unlocated') && filterButton) {
          document.querySelectorAll('.needs-page .view-toggle button').forEach((button) => {
            if (button.textContent?.trim().toLowerCase() === 'liste') button.click()
          })
        }
      })
      toolbar.insertBefore(control, viewToggle)
    }

    const countEl = control.querySelector('.unlocated-sos-toolbar-count')
    if (countEl) countEl.textContent = count
  }

  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true })
  sync()
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HelmetProvider>
      <BrowserRouter>
        <DialogProvider>
          <AppProvider>
            <App />
          </AppProvider>
        </DialogProvider>
      </BrowserRouter>
    </HelmetProvider>
  </StrictMode>
)

installUnlocatedSosToolbar()
