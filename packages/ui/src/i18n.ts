import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

i18n.use(initReactI18next).init({
  resources: { en: { translation: en } },
  lng: 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

/**
 * Humanize a snake_case or dot.separated identifier.
 * Checks i18n translations first, falls back to title-casing.
 */
export function humanize(key: string, ns?: string): string {
  // Try namespaced lookup first
  if (ns) {
    const result = i18n.t(`${ns}.${key}`, { defaultValue: '' });
    if (result) return result;
  }
  // Try all namespaces: steps, operations, status
  for (const namespace of ['steps', 'operations', 'status']) {
    const result = i18n.t(`${namespace}.${key}`, { defaultValue: '' });
    if (result) return result;
  }
  // Fallback: title-case the snake_case/dot.separated string
  return key
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export default i18n;
