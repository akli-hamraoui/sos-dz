import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import fr from './locales/fr.json'
import ar from './locales/ar.json'

const STORAGE_KEY = 'rassemble_language'
const RTL_LANGUAGES = ['ar']

export function getStoredLanguage() {
  return localStorage.getItem(STORAGE_KEY) || 'fr' // French default, per spec
}

export function applyDirection(lang) {
  const dir = RTL_LANGUAGES.includes(lang) ? 'rtl' : 'ltr'
  document.documentElement.setAttribute('dir', dir)
  document.documentElement.setAttribute('lang', lang)
}

export function setLanguage(lang) {
  localStorage.setItem(STORAGE_KEY, lang)
  i18n.changeLanguage(lang)
  applyDirection(lang)
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    fr: { translation: fr },
    ar: { translation: ar },
  },
  lng: getStoredLanguage(),
  fallbackLng: 'fr',
  interpolation: { escapeValue: false },
})

applyDirection(getStoredLanguage())

export default i18n
