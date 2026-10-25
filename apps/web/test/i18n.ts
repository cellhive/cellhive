import { createInstance, type i18n as I18n, type ResourceKey } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { NAMESPACES, type Language } from '../src/lib/i18n/i18n';

const modules = import.meta.glob<{ default: ResourceKey }>('../src/locales/*/*.json', {
  eager: true,
});

/** Every locale file, as `{ en: { common: {…}, … }, vi: {…} }`. */
export function localeResources(): Record<string, Record<string, ResourceKey>> {
  const resources: Record<string, Record<string, ResourceKey>> = {};
  for (const [path, module] of Object.entries(modules)) {
    const match = /\/locales\/([^/]+)\/([^/]+)\.json$/u.exec(path);
    if (match === null) continue;
    const [, language = '', namespace = ''] = match;
    resources[language] ??= {};
    resources[language][namespace] = module.default;
  }
  return resources;
}

/** A synchronous i18next instance with all bundled translations. */
export async function createTestI18n(language: Language = 'en'): Promise<I18n> {
  const instance = createInstance();
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: false,
    ns: [...NAMESPACES],
    defaultNS: 'common',
    resources: localeResources(),
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  return instance;
}
