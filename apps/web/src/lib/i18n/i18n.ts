import i18next, { type BackendModule, type i18n as I18n, type ResourceKey } from 'i18next';
import { initReactI18next } from 'react-i18next';

import { PREFERENCE_KEYS, readPreference, writePreference } from '../preferences';

/** UI languages: `en` is the source, `vi` complete (SPEC §18). */
export const LANGUAGES = ['en', 'vi'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

/** One namespace per feature (FRONTEND §9.1), loaded on demand. */
export const NAMESPACES = [
  'common',
  'errors',
  'auth',
  'org',
  'base',
  'grid',
  'trash',
  'field',
  'record',
  'history',
  'view',
  'kanban',
  'toolbar',
  'share',
  'sharePage',
  'import',
  'export',
  'form',
  'tree',
  'link',
  'attachment',
  'subtable',
  'formula',
  'lookup',
  'automation',
  'automationBuilder',
  'automationEmail',
  'automationRuns',
  'notifications',
  'emailIdentities',
  'verifySender',
  'emailSettings',
  'telegramBots',
  'emailImages',
  'incomingWebhooks',
  'automationHttp',
  'orgIntegrations',
  'baseSettings',
  'account',
  'apiTokens',
  'audit',
  'dashboard',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language);
}

/** `vi-VN` → `vi`; unsupported → `null`. */
export function matchLanguage(tag: string | null | undefined): Language | null {
  if (tag === null || tag === undefined) return null;
  const primary = tag.toLowerCase().split('-')[0];
  return isLanguage(primary) ? primary : null;
}

const loaders = import.meta.glob<{ default: ResourceKey }>('../../locales/*/*.json');

/** Loads `locales/<lng>/<ns>.json` as a separate chunk. */
const lazyBackend: BackendModule = {
  type: 'backend',
  init: () => undefined,
  read(language, namespace, callback) {
    const load = loaders[`../../locales/${language}/${namespace}.json`];
    if (load === undefined) {
      callback(null, {});
      return;
    }
    load().then(
      (module) => {
        callback(null, module.default);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : null, false);
      },
    );
  },
};

/** Stored choice, else the browser language, else English. */
export function initialLanguage(): Language {
  const stored = matchLanguage(readPreference(PREFERENCE_KEYS.language));
  if (stored !== null) return stored;
  for (const tag of navigator.languages) {
    const match = matchLanguage(tag);
    if (match !== null) return match;
  }
  return DEFAULT_LANGUAGE;
}

/** Whether the user picked a language here (then it wins over their profile locale). */
export function hasLanguagePreference(): boolean {
  return matchLanguage(readPreference(PREFERENCE_KEYS.language)) !== null;
}

function syncDocumentLanguage(language: string): void {
  document.documentElement.lang = language;
}

export async function initI18n(language: Language = initialLanguage()): Promise<I18n> {
  i18next.on('languageChanged', syncDocumentLanguage);
  await i18next
    .use(lazyBackend)
    .use(initReactI18next)
    .init({
      lng: language,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: LANGUAGES,
      ns: ['common', 'errors'],
      defaultNS: 'common',
      interpolation: { escapeValue: false },
      returnNull: false,
      react: { useSuspense: true },
    });
  syncDocumentLanguage(i18next.language);
  return i18next;
}

/** Switches language without a reload (FRONTEND §9.1) and remembers the choice. */
export async function changeLanguage(language: Language, remember = true): Promise<void> {
  if (remember) writePreference(PREFERENCE_KEYS.language, language);
  await i18next.changeLanguage(language);
}
