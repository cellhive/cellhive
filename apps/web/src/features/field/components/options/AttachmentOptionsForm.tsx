import { ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS } from '@cellhive/contracts';
import { Button, Checkbox, FormField, Input } from '@cellhive/ui';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { issueAt, useIssueText } from '../shared';

import type { AttachmentDraft, DraftIssue } from '../../draft';

/** Families of types offered as check boxes; each stands for these `accept` entries. */
export const ACCEPT_PRESETS = {
  images: ['image/*'],
  pdf: ['application/pdf'],
  office: [
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ],
  video: ['video/*'],
  audio: ['audio/*'],
  archives: ['application/zip', 'application/x-7z-compressed', 'application/vnd.rar'],
  text: ['text/plain', 'text/csv'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type AcceptPreset = keyof typeof ACCEPT_PRESETS;
const PRESETS = Object.keys(ACCEPT_PRESETS) as AcceptPreset[];
const PRESET_TYPES = new Set<string>(Object.values(ACCEPT_PRESETS).flat());

/** The presets fully present in `accept`, and the other entries (typed by the user). */
export function splitAccept(accept: readonly string[]): {
  presets: Set<AcceptPreset>;
  custom: string[];
} {
  const presets = new Set(
    PRESETS.filter((preset) => ACCEPT_PRESETS[preset].every((type) => accept.includes(type))),
  );
  return { presets, custom: accept.filter((type) => !PRESET_TYPES.has(type)) };
}

/** `accept` from checked presets and typed entries (separated by commas or spaces). */
export function joinAccept(presets: ReadonlySet<AcceptPreset>, custom: string): string[] {
  const typed = custom
    .split(/[\s,;]+/u)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '');
  const types = [
    ...PRESETS.filter((preset) => presets.has(preset)).flatMap((p) => ACCEPT_PRESETS[p]),
    ...typed,
  ];
  return [...new Set(types)];
}

export interface AttachmentOptionsFormProps {
  readonly value: AttachmentDraft;
  readonly issues: readonly DraftIssue[];
  readonly onChange: (value: AttachmentDraft) => void;
}

/**
 * `attachment` options (T418, CONTRACTS §2): the types accepted (any, or
 * families and MIME types), the most files per cell (1–100, default 100 like
 * Lark) and the blocked extensions (executables by default, BACKLOG S4
 * decision #6; empty blocks nothing). Checked again by the server on every
 * upload.
 */
export function AttachmentOptionsForm({ value, issues, onChange }: AttachmentOptionsFormProps) {
  const { t } = useTranslation('field');
  const issueText = useIssueText();
  const groupId = useId();
  const accept = value.accept;
  const { presets, custom } = splitAccept(accept ?? []);
  const customText = custom.join(', ');
  const acceptIssue =
    issueAt(issues, 'options.accept') ??
    issues.find((issue) => issue.path.startsWith('options.accept.'));
  const maxIssue = issueAt(issues, 'options.max_files');
  const blockedIssue =
    issueAt(issues, 'options.blocked_extensions') ??
    issues.find((issue) => issue.path.startsWith('options.blocked_extensions.'));

  const setPresets = (next: Set<AcceptPreset>) => {
    onChange({ ...value, accept: joinAccept(next, customText) });
  };

  return (
    <>
      <fieldset className="flex flex-col gap-2" aria-describedby={`${groupId}-hint`}>
        <legend className="mb-1 text-label text-fg">{t('attachment.accept')}</legend>
        <label className="flex items-center gap-2 text-body">
          <input
            type="radio"
            name={groupId}
            className="size-4"
            checked={accept === null}
            onChange={() => {
              onChange({ ...value, accept: null });
            }}
          />
          {t('attachment.acceptAny')}
        </label>
        <label className="flex items-center gap-2 text-body">
          <input
            type="radio"
            name={groupId}
            className="size-4"
            checked={accept !== null}
            onChange={() => {
              onChange({ ...value, accept: joinAccept(new Set(['images']), '') });
            }}
          />
          {t('attachment.acceptSome')}
        </label>
        {accept === null ? null : (
          <div className="ml-6 flex flex-col gap-2" data-testid="attachment-accept-presets">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {PRESETS.map((preset) => (
                <Checkbox
                  key={preset}
                  label={t(`attachment.presets.${preset}`)}
                  checked={presets.has(preset)}
                  onChange={(event) => {
                    const next = new Set(presets);
                    if (event.target.checked) next.add(preset);
                    else next.delete(preset);
                    setPresets(next);
                  }}
                />
              ))}
            </div>
            <FormField
              label={t('attachment.customTypes')}
              hint={t('attachment.customTypesHint')}
              error={issueText(acceptIssue)}
            >
              {(control) => (
                <Input
                  {...control}
                  autoComplete="off"
                  spellCheck={false}
                  defaultValue={customText}
                  placeholder={t('attachment.customTypesPlaceholder')}
                  onBlur={(event) => {
                    onChange({ ...value, accept: joinAccept(presets, event.target.value) });
                  }}
                />
              )}
            </FormField>
            {accept.length === 0 ? (
              <p className="text-label font-normal text-warning">{t('attachment.acceptNone')}</p>
            ) : null}
          </div>
        )}
        <p id={`${groupId}-hint`} className="text-label font-normal text-fg-muted">
          {t('attachment.acceptHint')}
        </p>
      </fieldset>
      <FormField
        label={t('attachment.maxFiles')}
        hint={t('attachment.maxFilesHint')}
        error={issueText(maxIssue)}
      >
        {(control) => (
          <Input
            {...control}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            className="max-w-32"
            value={value.maxFiles}
            onChange={(event) => {
              onChange({ ...value, maxFiles: event.target.value });
            }}
          />
        )}
      </FormField>
      <FormField
        label={t('attachment.blocked')}
        hint={t('attachment.blockedHint')}
        error={issueText(blockedIssue)}
      >
        {(control) => (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              {...control}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1"
              value={value.blocked}
              onChange={(event) => {
                onChange({ ...value, blocked: event.target.value });
              }}
            />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onChange({ ...value, blocked: ATTACHMENT_DEFAULT_BLOCKED_EXTENSIONS.join(', ') });
              }}
            >
              {t('attachment.blockedDefault')}
            </Button>
          </div>
        )}
      </FormField>
    </>
  );
}
