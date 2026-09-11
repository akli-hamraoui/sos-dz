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
window.L = L
L.Popup.mergeOptions({ maxWidth: 280, maxHeight: null, className: 'sosdz-map-popup', autoPan: false, keepInView: false })
import 'leaflet-gesture-handling'
import 'leaflet-gesture-handling/dist/leaflet-gesture-handling.css'
import './i18n'
import App from './App.jsx'
import { AppProvider } from './context/AppContext.jsx'
import { DialogProvider } from './context/DialogContext.jsx'

// Toolbar SOS for needs that have no real geographic position. The count is
// mirrored from the existing grouped map marker, so there is one source of
// truth and no second API request. Clicking it reuses the marker's existing
// filter behavior; from the list view it first switches to the map, waits for
// the grouped marker, then activates that same behavior.
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
        const marker = document.querySelector('.need-marker-pin-unlocated')?.closest('.leaflet-marker-icon')
        if (marker) {
          marker.click()
          return
        }
        const mapButton = Array.from(document.querySelectorAll('.needs-page .view-toggle button')).find((button) => button.textContent?.trim().toLowerCase() === 'carte')
        if (mapButton) {
          mapButton.click()
          window.setTimeout(() => {
            document.querySelector('.need-marker-pin-unlocated')?.closest('.leaflet-marker-icon')?.click()
          }, 500)
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
