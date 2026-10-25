import { parseAllowlistPattern, SECRET_MAX_ALLOWED_HOSTS } from '@cellhive/contracts';
import { cn } from '@cellhive/ui';
import { X } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { addHostChips, splitHostInput, type HostsAdded } from '../model';

import type { FieldControlProps } from '@cellhive/ui';

/** Keys that turn the typed text into a chip (besides Enter). */
const SEPARATORS = new Set([',', ';', ' ']);

export interface AllowedHostsInputProps {
  /** `id`, `aria-invalid`, `aria-describedby` of the `FormField` around it. */
  readonly control: FieldControlProps;
  readonly hosts: readonly string[];
  readonly draft: string;
  readonly onChange: (hosts: readonly string[], draft: string) => void;
}

/**
 * The allowed hosts of an HTTP secret as chips (BACKLOG T717, CONTRACTS
 * §24): type a host and press Enter (or a comma/space), or paste several;
 * each entry is checked with the allowlist's `parseAllowlistPattern` and
 * becomes a chip in its stored (canonical) form — an IP address, a URL or
 * `*.com` stays typed with the reason. Keyboard: Backspace in an empty input
 * moves to the last chip; on a chip, ←/→ move, Delete/Backspace removes it.
 * Every add/remove is announced through a polite live region. The text
 * input keeps `data-testid=secret-allowed-hosts`.
 */
export function AllowedHostsInput({ control, hosts, draft, onChange }: AllowedHostsInputProps) {
  const { t } = useTranslation('orgIntegrations');
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const report = (result: HostsAdded) => {
    const parts: string[] = [];
    if (result.added.length > 0) {
      parts.push(t('hosts.announceAdded', { hosts: result.added.join(', ') }));
    }
    const issues: string[] = [];
    if (result.duplicates.length > 0) {
      issues.push(t('hosts.duplicate', { hosts: result.duplicates.join(', ') }));
    }
    if (result.invalid.length > 0) {
      issues.push(t('hosts.invalid', { hosts: result.invalid.join(', ') }));
    }
    if (result.overflow.length > 0) {
      issues.push(t('hosts.full', { max: SECRET_MAX_ALLOWED_HOSTS }));
    }
    setProblem(issues.length === 0 ? null : issues.join(' '));
    parts.push(...issues);
    if (result.added.length > 0) {
      parts.push(t('hosts.count', { count: result.hosts.length, max: SECRET_MAX_ALLOWED_HOSTS }));
    }
    setAnnouncement(parts.join(' '));
  };

  /** Adds `text`; what could not be added stays in the input. */
  const commit = (text: string) => {
    if (splitHostInput(text).length === 0) return;
    const result = addHostChips(hosts, text);
    report(result);
    onChange(result.hosts, [...result.invalid, ...result.overflow].join(' '));
  };

  const remove = (index: number) => {
    const host = hosts[index];
    if (host === undefined) return;
    const next = hosts.filter((_, at) => at !== index);
    onChange(next, draft);
    setProblem(null);
    setAnnouncement(
      `${t('hosts.announceRemoved', { host })} ${t('hosts.count', {
        count: next.length,
        max: SECRET_MAX_ALLOWED_HOSTS,
      })}`,
    );
    // Focus the chip before it, else the input (the removed button is gone).
    const target = index > 0 ? index - 1 : null;
    window.requestAnimationFrame(() => {
      if (target !== null && target < next.length) chips.current[target]?.focus();
      else input.current?.focus();
    });
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || SEPARATORS.has(event.key)) {
      // Enter with nothing typed submits the form as usual.
      if (draft.trim() === '') {
        if (event.key !== 'Enter') event.preventDefault();
        return;
      }
      event.preventDefault();
      commit(draft);
      return;
    }
    const caretAtStart =
      event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0;
    if ((event.key === 'Backspace' || event.key === 'ArrowLeft') && caretAtStart) {
      if (hosts.length === 0) return;
      event.preventDefault();
      chips.current[hosts.length - 1]?.focus();
    }
  };

  const onChipKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        remove(index);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        chips.current[Math.max(0, index - 1)]?.focus();
        return;
      case 'ArrowRight':
        event.preventDefault();
        if (index + 1 < hosts.length) chips.current[index + 1]?.focus();
        else input.current?.focus();
        return;
      default:
    }
  };

  // "Will be saved as …" while the typed host differs from its stored form.
  const typed = splitHostInput(draft);
  const single = typed.length === 1 ? parseAllowlistPattern(typed[0] ?? '') : null;
  const preview =
    single !== null && single.pattern !== typed[0]
      ? t('hosts.savedAs', { host: single.pattern })
      : null;
  const problemId = `${id}-problem`;
  const describedBy =
    [control['aria-describedby'], problem === null ? null : problemId, `${id}-help`]
      .filter((item) => item !== null && item !== undefined)
      .join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          'flex min-h-control flex-wrap items-center gap-1.5 rounded-md border border-line-control bg-surface px-2 py-1.5 focus-within:outline-2 focus-within:outline-accent',
          (control['aria-invalid'] || problem !== null) && 'border-danger',
        )}
      >
        {hosts.length === 0 ? null : (
          <ul
            aria-label={t('hosts.listLabel')}
            className="contents"
            data-testid="secret-allowed-host-chips"
          >
            {hosts.map((host, index) => (
              <li
                key={host}
                className="inline-flex max-w-full items-center gap-0.5 rounded-sm bg-surface-sunken py-0.5 pr-0.5 pl-2 text-label text-fg"
                data-testid="secret-allowed-host-chip"
              >
                <span className="truncate font-code">{host}</span>
                <button
                  ref={(element) => {
                    chips.current[index] = element;
                  }}
                  type="button"
                  aria-label={t('hosts.remove', { host })}
                  className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-muted hover:bg-surface hover:text-fg focus-visible:outline-2 focus-visible:outline-accent max-lg:size-8"
                  onClick={() => {
                    remove(index);
                  }}
                  onKeyDown={(event) => {
                    onChipKey(event, index);
                  }}
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={input}
          id={control.id}
          type="text"
          value={draft}
          aria-invalid={control['aria-invalid'] || problem !== null}
          aria-describedby={describedBy}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          enterKeyHint="enter"
          placeholder={hosts.length === 0 ? t('secrets.form.allowedHostsPlaceholder') : undefined}
          className="min-w-32 flex-1 bg-transparent py-0.5 font-code text-body text-fg outline-none placeholder:text-fg-subtle max-lg:text-[16px]"
          data-testid="secret-allowed-hosts"
          onKeyDown={onInputKey}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
            if (splitHostInput(text).length < 2) return;
            event.preventDefault();
            commit(`${draft} ${text}`);
          }}
          onChange={(event) => {
            setProblem(null);
            onChange(hosts, event.target.value);
          }}
          onBlur={() => {
            // A host left typed becomes a chip when it is one (else it stays, flagged on save).
            if (typed.length > 0 && typed.every((entry) => parseAllowlistPattern(entry) !== null)) {
              commit(draft);
            }
          }}
        />
      </div>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <span
          id={`${id}-help`}
          className="min-w-0 flex-1 basis-48 text-label font-normal text-fg-muted"
        >
          {preview ?? t('hosts.keyboard')}
        </span>
        <span
          className="text-label font-normal text-fg-muted"
          data-testid="secret-allowed-hosts-count"
        >
          {t('hosts.count', { count: hosts.length, max: SECRET_MAX_ALLOWED_HOSTS })}
        </span>
      </div>
      {problem === null ? null : (
        <p
          id={problemId}
          className="text-label font-normal text-danger"
          data-testid="secret-allowed-hosts-problem"
        >
          {problem}
        </p>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  );
}
