import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { HelmetProvider } from 'react-helmet-async'
import './index.css'
import './footer-sos-fixes.css'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './sos-map-marker.css'
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
