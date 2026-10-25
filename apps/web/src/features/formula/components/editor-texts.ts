import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { EditorTexts } from '../editor/extensions';
import type { Suggestion } from '../model/completions';

/** First sentence of a description. */
function firstSentence(text: string): string {
  const end = text.search(/[.;:](\s|$)/u);
  return end === -1 ? text : text.slice(0, end);
}

/** Translated texts of the CodeMirror parts (sections, details, info), stable per language. */
export function useEditorTexts(): EditorTexts {
  const { t, i18n } = useTranslation(['formula', 'field']);
  const language = i18n.language;
  return useMemo((): EditorTexts => {
    const locale = language.startsWith('vi') ? 'vi' : 'en';
    return {
      sectionName: (section) => {
        switch (section.kind) {
          case 'fields':
            return t('formula:suggest.fields', { table: section.table });
          case 'tables':
            return t('formula:suggest.tables');
          case 'variables':
            return t('formula:suggest.variables');
          case 'tableFunctions':
            return t('formula:suggest.tableFunctions');
          case 'functions':
            return t(`formula:catalogue.tabs.${section.group}`);
        }
      },
      detail: (item: Suggestion) => {
        switch (item.kind) {
          case 'field':
            return item.field === undefined
              ? ''
              : t(`field:types.${item.field.type}`, { defaultValue: item.field.type });
          case 'table':
            return t('formula:suggest.table');
          case 'function':
            return item.definition === undefined
              ? ''
              : firstSentence(item.definition.description[locale]);
          case 'variable':
            return t('formula:suggest.variable');
          case 'keyword':
            return '';
        }
      },
      info: (item: Suggestion) => {
        if (item.kind === 'function' && item.definition !== undefined) {
          return item.definition.description[locale];
        }
        if (item.kind === 'field' && item.field !== undefined) {
          const options = item.field.options['options'];
          if (!Array.isArray(options) || options.length === 0) return null;
          const names = options.flatMap((option: unknown) =>
            typeof option === 'object' &&
            option !== null &&
            'name' in option &&
            typeof option.name === 'string'
              ? [option.name]
              : [],
          );
          return t('formula:catalogue.options', { list: names.join(', ') });
        }
        return null;
      },
      completions: t('formula:suggest.label'),
      tabHint: t('formula:suggest.tab'),
      placeholder: t('formula:editor.placeholder'),
    };
  }, [t, language]);
}
