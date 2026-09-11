import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const jsx = await readFile(new URL('../src/pages/UrgentSOS.jsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/urgent-sos-wizard-fixes.css', import.meta.url), 'utf8')
const icons = await readFile(new URL('../src/icons.jsx', import.meta.url), 'utf8')
const api = await readFile(new URL('../src/api.js', import.meta.url), 'utf8')

assert.match(icons, /export function IconReplay\(/, 'IconReplay must exist')
assert.match(jsx, /IconReplay/, 'SOS audio must expose a replay icon')
assert.match(jsx, /\[ended,setEnded\]/, 'audio needs a distinct ended state')
assert.match(jsx, /onEnded=\{\(\)=>\{setPlay\(false\);setEnded\(true\)\}\}/, 'audio end must switch to replay')
assert.match(jsx, /Géolocalisation confirmée/, 'successful GPS result must be visible before confirmation')
assert.match(jsx, /Géolocalisation non fournie/, 'GPS refusal/absence must be visible before confirmation')
assert.match(jsx, /apiUpload\('\/needs\/voice-guide\/'/, 'SOS must still submit through the voice-guide API')
assert.match(css, /\.urgent-sos-audio\.is-muted .*color:#c62828/, 'muted audio icon must be red')
assert.match(css, /\.urgent-sos-audio-btn\{[^}]*display:inline-flex[^}]*align-items:center[^}]*justify-content:center/, 'audio icon must be centered')
assert.match(css, /\.urgent-sos-location-confirmation\.confirmed/, 'confirmed GPS state must have dedicated styling')
assert.match(css, /\.urgent-sos-location-confirmation\.refused/, 'refused GPS state must have dedicated styling')

assert.match(api, /api\.bigdatacloud\.net\/data\/reverse-geocode-client/, 'SOS must use BigDataCloud free client-side reverse geocoding')
assert.match(api, /BIGDATACLOUD_RETRY_DELAY_MS = 2000/, 'BigDataCloud retries must wait 2 seconds')
assert.match(api, /BIGDATACLOUD_MAX_RETRIES = 3/, 'BigDataCloud must retry 3 times')
assert.match(api, /for \(let attempt = 0; attempt <= BIGDATACLOUD_MAX_RETRIES; attempt \+= 1\)/, 'initial request plus 3 retries must be attempted')
assert.match(api, /countryCode !== 'DZ'/, 'SOS location must reject a non-Algeria country')
assert.match(api, /validation GPS serveur/, 'BigDataCloud failure must fall back to server GPS validation')
assert.match(api, /verifyUrgentSOSLocation\(formData\)/, 'voice-guide upload must trigger location verification')

console.log('✓ Urgent SOS static regression tests passed')
