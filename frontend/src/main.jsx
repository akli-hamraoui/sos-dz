import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { HelmetProvider } from 'react-helmet-async'
import './index.css'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
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
//
// autoPan only keeps the popup within the *map's own* pixel bounds -- it
// has no idea our zoom control (top-left) and "recenter on me" button
// (top-right, see .locate-btn in index.css) are fixed overlays sitting on
// top of the map, so a marker near the top of the visible area could
// still open its popup fully "in bounds" but visually underneath/behind
// those controls (confirmed live). A tall top-left margin -- roughly the
// stacked zoom buttons' own height plus their inset -- keeps the popup
// clear of them; asymmetric padding (rather than a single autoPanPadding)
// is what lets the top get more room than the other three sides.
L.Popup.mergeOptions({
  maxWidth: 260,
  autoPanPaddingTopLeft: [16, 90],
  autoPanPaddingBottomRight: [16, 16],
})
// Registers the `gestureHandling` map option used on every Leaflet map in
// this app (see NeedsList/CollectionPoints/NeedDetail): a single finger on
// a mobile touchscreen pans the *page*, not the map -- panning the map
// itself needs two fingers (or ctrl+scroll on desktop), with a brief
// on-screen hint the first time someone touches it. Fixes the map
// swallowing a page-scroll gesture on mobile.
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
