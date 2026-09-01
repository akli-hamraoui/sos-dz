// Minimal line-icon set (24x24, stroke-based, currentColor) used in place of
// emoji throughout the app -- emoji render inconsistently across devices/OS
// font sets and clash with the flat black/white design system. These follow
// the same visual language as the rest of the UI: thin, rounded strokes, no
// fill, single color that inherits from context (so active/hover states
// just work via CSS `color`).

const base = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
}

export function IconHome(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9h5v-5.5h2V19h5v-9" />
    </svg>
  )
}

export function IconNeeds(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 20.5s-7-4.35-9.3-8.9C1.2 8.2 3 5 6.3 5c1.8 0 3.2 1 3.7 2.4C10.5 6 11.9 5 13.7 5 17 5 18.8 8.2 17.3 11.6 15 16.15 12 20.5 12 20.5Z" />
    </svg>
  )
}

export function IconBox(props) {
  return (
    <svg {...base} {...props}>
      <path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5v-9Z" />
      <path d="M3.5 7.5 12 12l8.5-4.5" />
      <path d="M12 12v9" />
    </svg>
  )
}

export function IconHelp(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.3 9.6a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.1.9-1.1 1.7" />
      <circle cx="12" cy="17" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconPlus(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function IconWarning(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5 21.5 20h-19L12 3.5Z" />
      <path d="M12 9.5v4.2" />
      <circle cx="12" cy="16.7" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconWifiOff(props) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 2.5l19 19" />
      <path d="M5 8.8a15 15 0 0 1 4.4-2.6M18.9 8.7a15 15 0 0 1 1.6 1.2M8.3 12.6a9 9 0 0 1 4.9-1.5c1 0 1.9.15 2.8.45M12 16.5a4.5 4.5 0 0 1 2.3.65" />
      <circle cx="12" cy="20" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconCheckCircle(props) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.3l2.6 2.6L16.3 9" />
    </svg>
  )
}

export function IconMapPin(props) {
  return (
    <svg {...base} {...props}>
      <path d="M12 21.5S5 14.8 5 9.8a7 7 0 1 1 14 0c0 5-7 11.7-7 11.7Z" />
      <circle cx="12" cy="9.8" r="2.3" />
    </svg>
  )
}

export function IconMic(props) {
  return (
    <svg {...base} {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3M9 20.5h6" />
    </svg>
  )
}

export function IconVideoCam(props) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="6.5" width="12" height="11" rx="2.5" />
      <path d="M15 10.2 21 7v10l-6-3.2Z" />
    </svg>
  )
}

export function IconCamera(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-2h7l1 2h2a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5Z" />
      <circle cx="12" cy="13" r="3.3" />
    </svg>
  )
}

export function IconTrash(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13" />
    </svg>
  )
}

export function IconMenu(props) {
  return (
    <svg {...base} {...props}>
      <path d="M4 6.5h16M4 12h16M4 17.5h16" />
    </svg>
  )
}

export function IconTruck(props) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 7.5h11v8h-11Z" />
      <path d="M13.5 11h4l3 2.8v1.7h-7Z" />
      <circle cx="7" cy="18" r="1.7" />
      <circle cx="17" cy="18" r="1.7" />
      <path d="M2.5 16h2.8M15.5 16h.2M18.7 16H21" />
    </svg>
  )
}

export function IconClose(props) {
  return (
    <svg {...base} {...props}>
      <path d="M5 5l14 14M19 5 5 19" />
    </svg>
  )
}
