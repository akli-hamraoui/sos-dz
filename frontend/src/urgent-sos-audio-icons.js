// Keep the urgent-SOS instruction control visual-only and stateful without
// coupling the page to an icon library. React already toggles ▶/⏸ text;
// we mirror that state to a data attribute used by the scoped CSS.
const sync = (button) => {
  if (!button.matches('.urgent-sos-audio-btn')) return
  button.dataset.playing = button.textContent.includes('⏸') ? 'true' : 'false'
}

const scan = (root = document) => {
  root.querySelectorAll?.('.urgent-sos-audio-btn').forEach(sync)
}

const boot = () => {
  scan()
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData' || mutation.type === 'childList') {
        const button = mutation.target.closest?.('.urgent-sos-audio-btn') || mutation.target.querySelector?.('.urgent-sos-audio-btn')
        if (button) sync(button)
        scan(mutation.target)
      }
    }
  })
  observer.observe(document.body, { subtree: true, childList: true, characterData: true })
}

if (document.body) boot()
else window.addEventListener('DOMContentLoaded', boot, { once: true })
