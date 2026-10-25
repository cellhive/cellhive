import {
  bracketName,
  FUNCTION_GROUPS,
  listCatalogue,
  syntaxOf,
  type CatalogueEntry,
  type FunctionGroup,
  type Locale,
} from '@cellhive/formula-engine';
import { Button, cn } from '@cellhive/ui';
import { Plus, Search } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { foldForMatch } from '../model/match';

import { FormulaText } from './FormulaText';

import type { FormulaSchema, FormulaSchemaField } from '../model/schema';

/**
 * Function catalogue of the formula editor (board "S4b · Trình soạn công
 * thức - dialog", SPEC §9.3): groups (fields, tables, variables, then the
 * function groups with their counts) / a searchable list / the documentation
 * of the selected entry from `@cellhive/formula-engine` (description, syntax,
 * examples in the UI language, return type, notes). Enter or double click
 * inserts at the caret; "Insert example" inserts the example.
 */

export type CatalogueTab = 'fields' | 'tables' | 'variables' | FunctionGroup;

type Item =
  | { kind: 'field'; key: string; label: string; field: FormulaSchemaField }
  | { kind: 'table'; key: string; label: string; count: number }
  | { kind: 'variable'; key: string; label: string }
  | { kind: 'function'; key: string; label: string; entry: CatalogueEntry };

export interface CatalogueProps {
  readonly schema: FormulaSchema;
  /** `CurrentValue` and `LET` names available at the caret. */
  readonly variables: readonly string[];
  readonly onInsert: (text: string, caret?: number) => void;
  /** Show the guide (header "Guide" button) instead of an entry. */
  readonly guide: boolean;
  readonly onGuideShown: () => void;
}

const TABS: readonly CatalogueTab[] = ['fields', 'tables', 'variables', ...FUNCTION_GROUPS];

function groupOfEntry(entry: CatalogueEntry): FunctionGroup {
  return entry.group === 'geo' ? 'number' : entry.group;
}

function insertion(item: Item): { text: string; caret?: number } {
  switch (item.kind) {
    case 'field':
      return { text: bracketName(item.label) };
    case 'table':
      return { text: `${bracketName(item.label)}.` };
    case 'variable':
      return { text: item.label };
    case 'function': {
      const entry = item.entry;
      const empty =
        !entry.phase2 && entry.signatures.every((signature) => signature.params.length === 0);
      return {
        text: `${entry.name}()`,
        caret: empty ? entry.name.length + 2 : entry.name.length + 1,
      };
    }
  }
}

/** First sentence of a description (list rows). */
function summary(text: string): string {
  const end = text.search(/[.;:](\s|$)/u);
  return end === -1 ? text : text.slice(0, end);
}

export function Catalogue({ schema, variables, onInsert, guide, onGuideShown }: CatalogueProps) {
  const { t, i18n } = useTranslation(['formula', 'field']);
  const locale: Locale = i18n.language.startsWith('vi') ? 'vi' : 'en';
  const listId = useId();
  const searchId = useId();
  const [tab, setTab] = useState<CatalogueTab>('fields');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const tabRefs = useRef(new Map<CatalogueTab, HTMLButtonElement>());

  const all = useMemo(() => {
    const table = schema.tables.find((item) => item.id === schema.tableId);
    const byTab = new Map<CatalogueTab, Item[]>(TABS.map((name) => [name, []]));
    for (const field of table?.fields ?? []) {
      byTab.get('fields')?.push({ kind: 'field', key: `f:${field.id}`, label: field.name, field });
    }
    for (const item of schema.tables) {
      byTab.get('tables')?.push({
        kind: 'table',
        key: `t:${item.id}`,
        label: item.name,
        count: item.fields.length,
      });
    }
    for (const name of ['CurrentValue', ...variables]) {
      byTab.get('variables')?.push({ kind: 'variable', key: `v:${name}`, label: name });
    }
    for (const entry of listCatalogue()) {
      if (entry.name === 'LET') {
        byTab.get('variables')?.push({ kind: 'function', key: 'fn:LET', label: 'LET', entry });
        continue;
      }
      byTab.get(groupOfEntry(entry))?.push({
        kind: 'function',
        key: `fn:${entry.name}`,
        label: entry.name,
        entry,
      });
    }
    return byTab;
  }, [schema, variables]);

  const folded = foldForMatch(query.trim());
  const items =
    folded === ''
      ? (all.get(tab) ?? [])
      : [...all.values()].flat().filter((item) => foldForMatch(item.label).includes(folded));
  const selected = items.find((item) => item.key === selectedKey) ?? items[0];
  const activeId = (item: Item) => `${listId}-${item.key.replace(/[^\w-]/gu, '_')}`;

  const pick = (item: Item | undefined) => {
    if (item === undefined) return;
    setSelectedKey(item.key);
    onGuideShown();
  };

  const insert = (item: Item | undefined) => {
    if (item === undefined || (item.kind === 'function' && item.entry.phase2)) return;
    const { text, caret } = insertion(item);
    onInsert(text, caret);
  };

  const onListKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = selected === undefined ? -1 : items.indexOf(selected);
    const move = (next: number) => {
      event.preventDefault();
      const item = items[Math.max(0, Math.min(items.length - 1, next))];
      pick(item);
      if (item !== undefined) {
        document.getElementById(activeId(item))?.scrollIntoView({ block: 'nearest' });
      }
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Enter') {
      event.preventDefault();
      insert(selected);
    }
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, name: CatalogueTab) => {
    const index = TABS.indexOf(name);
    const next =
      event.key === 'ArrowDown'
        ? TABS[(index + 1) % TABS.length]
        : event.key === 'ArrowUp'
          ? TABS[(index - 1 + TABS.length) % TABS.length]
          : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setTab(next);
    setQuery('');
    tabRefs.current.get(next)?.focus();
  };

  const tabLabel = (name: CatalogueTab) => t(`formula:catalogue.tabs.${name}`);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[8.5rem_minmax(0,13rem)_minmax(0,1fr)] lg:grid-cols-[10.5rem_minmax(0,15.5rem)_minmax(0,1fr)]">
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label={t('formula:catalogue.groups')}
        className="flex min-h-0 flex-col gap-0.5 overflow-y-auto border-r border-line py-2"
      >
        {TABS.map((name) => {
          const active = folded === '' && tab === name;
          return (
            <button
              key={name}
              ref={(element) => {
                if (element === null) tabRefs.current.delete(name);
                else tabRefs.current.set(name, element);
              }}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={listId}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => {
                setTab(name);
                setQuery('');
                setSelectedKey(null);
              }}
              onKeyDown={(event) => {
                onTabKey(event, name);
              }}
              className={cn(
                'mx-1.5 flex h-[30px] shrink-0 items-center rounded-md px-2.5 text-left text-body text-fg',
                'hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent',
                active && 'bg-accent-soft font-medium',
              )}
            >
              <span className="truncate">{tabLabel(name)}</span>
              <span className="ml-auto pl-2 text-label font-normal text-fg-muted tabular-nums">
                {(all.get(name) ?? []).length}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex min-h-0 flex-col border-r border-line">
        <div className="p-2">
          <label
            htmlFor={searchId}
            className="flex h-8 items-center gap-2 rounded-md border border-line-control bg-surface px-2.5 focus-within:border-accent"
          >
            <Search aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
            <span className="sr-only">{t('formula:catalogue.search')}</span>
            <input
              id={searchId}
              type="search"
              value={query}
              placeholder={t('formula:catalogue.search')}
              className="min-w-0 flex-1 bg-transparent text-body text-fg outline-none placeholder:text-fg-subtle"
              onChange={(event) => {
                setQuery(event.target.value);
                setSelectedKey(null);
              }}
            />
          </label>
        </div>
        <ul
          id={listId}
          role="listbox"
          tabIndex={0}
          aria-label={folded === '' ? tabLabel(tab) : t('formula:catalogue.results')}
          aria-activedescendant={selected === undefined ? undefined : activeId(selected)}
          onKeyDown={onListKey}
          className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1 pb-1.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
          data-testid="formula-catalogue-list"
        >
          {items.length === 0 ? (
            <li role="presentation" className="px-2 py-2 text-label font-normal text-fg-muted">
              {t('formula:catalogue.empty')}
            </li>
          ) : null}
          {items.map((item) => (
            <li
              key={item.key}
              id={activeId(item)}
              role="option"
              aria-selected={item === selected}
              onClick={() => {
                pick(item);
              }}
              onDoubleClick={() => {
                insert(item);
              }}
              className={cn(
                'flex h-[30px] shrink-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md px-2 whitespace-nowrap text-fg',
                item === selected ? 'bg-accent-soft font-medium' : 'hover:bg-surface-sunken',
              )}
            >
              <span
                className={cn(
                  item.kind === 'function' ? 'font-mono text-mono' : 'text-body',
                  'truncate',
                )}
              >
                {item.label}
              </span>
              <span className="ml-auto truncate text-label font-normal text-fg-muted">
                {item.kind === 'function'
                  ? item.entry.phase2
                    ? t('formula:catalogue.phase2')
                    : summary(item.entry.description[locale])
                  : item.kind === 'field'
                    ? t(`field:types.${item.field.type}`, { defaultValue: item.field.type })
                    : item.kind === 'table'
                      ? t('formula:catalogue.fieldCount', { count: item.count })
                      : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <section
        aria-label={t('formula:catalogue.docs')}
        className="flex min-h-0 min-w-0 flex-col gap-2.5 overflow-y-auto px-4 py-3.5 text-body leading-normal"
        data-testid="formula-docs"
      >
        {guide ? (
          <Guide />
        ) : selected === undefined ? null : (
          <Docs item={selected} locale={locale} onInsert={onInsert} insert={insert} />
        )}
      </section>
    </div>
  );
}

function Docs({
  item,
  locale,
  onInsert,
  insert,
}: {
  item: Item;
  locale: Locale;
  onInsert: (text: string, caret?: number) => void;
  insert: (item: Item) => void;
}) {
  const { t } = useTranslation(['formula', 'field']);
  const insertButton = (
    <Button
      variant="secondary"
      size="sm"
      className="self-start"
      onClick={() => {
        insert(item);
      }}
    >
      <Plus aria-hidden="true" className="size-3.5" />
      {t('formula:catalogue.insert')}
    </Button>
  );
  switch (item.kind) {
    case 'field': {
      const options = item.field.options['options'];
      const names = Array.isArray(options)
        ? options.flatMap((option: unknown) =>
            typeof option === 'object' &&
            option !== null &&
            typeof (option as { name?: unknown }).name === 'string'
              ? [(option as { name: string }).name]
              : [],
          )
        : [];
      return (
        <>
          <DocTitle
            name={item.label}
            kind={t(`field:types.${item.field.type}`, { defaultValue: item.field.type })}
          />
          <p className="text-fg-muted">{t('formula:catalogue.fieldDoc')}</p>
          {names.length > 0 ? (
            <p className="text-fg-muted">
              {t('formula:catalogue.options', { list: names.join(', ') })}
            </p>
          ) : null}
          {item.field.linkTableId === null ? null : (
            <p className="text-fg-muted">{t('formula:catalogue.linkDoc')}</p>
          )}
          {insertButton}
        </>
      );
    }
    case 'table':
      return (
        <>
          <DocTitle name={item.label} kind={t('formula:catalogue.table')} />
          <p className="text-fg-muted">{t('formula:catalogue.tableDoc')}</p>
          <Example
            source={`${bracketName(item.label)}.FILTER(CurrentValue.[…] = […]).[…]`}
            schema={null}
          />
          {insertButton}
        </>
      );
    case 'variable':
      return (
        <>
          <DocTitle name={item.label} kind={t('formula:catalogue.tabs.variables')} />
          <p className="text-fg-muted">
            {item.label === 'CurrentValue'
              ? t('formula:catalogue.currentValueDoc')
              : t('formula:catalogue.letDoc')}
          </p>
          {insertButton}
        </>
      );
    case 'function': {
      const entry = item.entry;
      const examples = entry.phase2 ? [] : entry.examples;
      return (
        <>
          <DocTitle name={entry.name} kind={t(`formula:catalogue.tabs.${groupOfEntry(entry)}`)} />
          {entry.phase2 ? (
            <p className="rounded-md bg-surface-sunken px-2.5 py-1.5 text-label font-normal text-fg-muted">
              {t('formula:catalogue.phase2Doc')}
            </p>
          ) : null}
          <p className="text-fg">{entry.description[locale]}</p>
          <div className="flex flex-col gap-1">
            <span className="text-label text-fg-muted">{t('formula:catalogue.syntax')}</span>
            {syntaxOf(entry, locale).map((line) => (
              <code key={line} className="font-mono text-mono break-words text-fg">
                {line}
              </code>
            ))}
          </div>
          {examples.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-label text-fg-muted">{t('formula:catalogue.examples')}</span>
              {examples.map((example) => (
                <div key={example.formula.en} className="flex flex-col gap-1">
                  <Example source={example.formula[locale]} schema={null} />
                  <span className="text-label font-normal text-fg-muted">
                    {t('formula:catalogue.exampleResult', { result: example.result[locale] })}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {entry.phase2 ? null : (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-label font-normal text-fg-muted">
                {t('formula:catalogue.returns', {
                  type: entry.signatures.map((signature) => signature.returns).join(' | '),
                })}
              </span>
              <span className="ml-auto flex gap-2">
                {examples[0] === undefined ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      onInsert(examples[0]?.formula[locale] ?? '');
                    }}
                  >
                    {t('formula:catalogue.insertExample')}
                  </Button>
                )}
                {insertButton}
              </span>
            </div>
          )}
          {entry.volatile ? (
            <p className="text-label font-normal text-fg-muted">
              {t('formula:catalogue.volatile')}
            </p>
          ) : null}
          {!entry.phase2 && entry.notes !== undefined ? (
            <p className="text-label font-normal text-fg-muted">{entry.notes[locale]}</p>
          ) : null}
        </>
      );
    }
  }
}

function DocTitle({ name, kind }: { name: string; kind: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <h3 className="font-mono text-heading font-medium text-fg">{name}</h3>
      <span className="text-label font-normal text-fg-muted">{kind}</span>
    </div>
  );
}

function Example({ source, schema }: { source: string; schema: FormulaSchema | null }) {
  return (
    <div className="rounded-md bg-surface-sunken px-2.5 py-1.5 leading-[26px]">
      <FormulaText source={source} schema={schema} className="text-mono" />
    </div>
  );
}

const SHORTCUTS = ['suggest', 'accept', 'close', 'newline', 'confirm'] as const;

function Guide() {
  const { t } = useTranslation('formula');
  return (
    <>
      <h3 className="text-heading text-fg">{t('guide.title')}</h3>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-fg-muted">
        <li>{t('guide.fields')}</li>
        <li>{t('guide.links')}</li>
        <li>{t('guide.tables')}</li>
        <li>{t('guide.text')}</li>
        <li>{t('guide.operators')}</li>
      </ul>
      <h4 className="text-label text-fg-muted">{t('guide.keyboard')}</h4>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {SHORTCUTS.map((name) => (
          <div key={name} className="contents">
            <dt>
              <kbd className="rounded-sm border border-line-strong px-1 font-sans text-label font-normal">
                {t(`guide.keys.${name}`)}
              </kbd>
            </dt>
            <dd className="text-fg-muted">{t(`guide.actions.${name}`)}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
