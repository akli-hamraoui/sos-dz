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
