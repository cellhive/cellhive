import {
  AI_TEST_MAX_OUTPUT_TOKENS,
  type AiSettingsDto,
  type AiSettingsTestResult,
} from '@cellhive/contracts';
import { Button, cn, FormField, Input, Skeleton, Spinner } from '@cellhive/ui';
import { Info, KeyRound, PlugZap, TriangleAlert } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ErrorAlert } from '../../../../lib/errors/ErrorAlert';
import { NoteBox, SettingsSection } from '../../email/components/SettingsSection';
import { useTestAiSettings } from '../api';
import {
  displayHostOf,
  keyHostMismatch,
  presetOf,
  PROVIDER_PRESETS,
  testRequestOf,
  testViewOf,
  type AiDraft,
  type DraftField,
} from '../model';

import { AllowDialog, TestResult } from './TestResult';

/** One test and what it tried: the result keeps naming them while the form changes. */
interface LastTest {
  readonly result: AiSettingsTestResult;
  readonly baseUrl: string;
  readonly model: string;
}

function KeyField({
  settings,
  draft,
  error,
  onChange,
}: {
  readonly settings: AiSettingsDto;
  readonly draft: AiDraft;
  readonly error: string | undefined;
  readonly onChange: (patch: Partial<AiDraft>) => void;
}) {
  const { t } = useTranslation('orgAi');
  const labelId = useId();
  // "Replace key" moves the focus to the input it reveals.
  const focusInput = useRef(false);
  const saved = settings.api_key;
  const mismatch = keyHostMismatch(settings, draft);

  if (saved !== null && draft.key.mode !== 'replace') {
    const removed = draft.key.mode === 'none';
    return (
      <div className="flex flex-col gap-1" role="group" aria-labelledby={labelId}>
        <span id={labelId} className="text-label text-fg">
          {t('provider.key.label')}
        </span>
        <div
          data-testid={removed ? 'ai-key-removed' : 'ai-key-saved'}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-surface-sunken px-3 py-2 motion-safe:animate-fade-in"
        >
          <KeyRound aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
          {removed ? (
            <span className="min-w-0 flex-1 basis-48 text-body text-fg">
              {t('provider.key.removed')}
            </span>
          ) : (
            <span className="flex min-w-0 flex-1 basis-48 flex-col">
              <span className="text-body font-medium text-fg">{t('provider.key.saved')}</span>
              <span className="text-label font-normal break-words text-fg-muted">
                {t('provider.key.savedFor', { host: saved.allowed_hosts.join(', ') })}
              </span>
            </span>
          )}
          <span className="flex flex-wrap gap-2">
            {removed ? (
              <Button
                variant="secondary"
                data-testid="ai-key-undo"
                onClick={() => {
                  onChange({ key: { mode: 'keep' } });
                }}
              >
                {t('provider.key.undo')}
              </Button>
            ) : (
              <>
                <Button
                  variant="secondary"
                  data-testid="ai-key-replace"
                  onClick={() => {
                    onChange({ key: { mode: 'replace', value: '' } });
                    focusInput.current = true;
                  }}
                >
                  {t('provider.key.replace')}
                </Button>
                <Button
                  variant="ghost"
                  data-testid="ai-key-remove"
                  onClick={() => {
                    onChange({ key: { mode: 'none' } });
                  }}
                >
                  {t('provider.key.remove')}
                </Button>
              </>
            )}
          </span>
        </div>
        {mismatch === null ? null : (
          <NoteBox tone="warning" icon={<TriangleAlert />} data-testid="ai-key-mismatch">
            {t('provider.key.hostMismatch', mismatch)}
          </NoteBox>
        )}
        {error === undefined ? null : (
          <p className="text-label font-normal text-danger" data-testid="ai-key-error">
            {error}
          </p>
        )}
      </div>
    );
  }

  const value = draft.key.mode === 'replace' ? draft.key.value : '';
  return (
    <div className="flex flex-col gap-1 motion-safe:animate-reveal">
      <FormField
        label={saved === null ? t('provider.key.optional') : t('provider.key.label')}
        hint={saved === null ? t('provider.key.hint') : t('provider.key.replaceHint')}
        error={error}
      >
        {(control) => (
          <Input
            {...control}
            ref={(element) => {
              if (element === null || !focusInput.current) return;
              focusInput.current = false;
              element.focus();
            }}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            className="font-mono"
            data-testid="ai-key-input"
            value={value}
            onChange={(event) => {
              onChange({ key: { mode: 'replace', value: event.target.value } });
            }}
          />
        )}
      </FormField>
      {saved === null ? null : (
        <Button
          variant="ghost"
          size="sm"
          className="w-fit max-lg:h-control"
          data-testid="ai-key-keep"
          onClick={() => {
            onChange({ key: { mode: 'keep' } });
          }}
        >
          {t('provider.key.keep')}
        </Button>
      )}
    </div>
  );
}

/**
 * The provider (CONTRACTS §29.1): base URL with presets, model (suggested
 * from the models the last test found), the write-only key, and "Test
 * connection" — it tries the draft as is, saved or not.
 */
export function ProviderSection({
  orgId,
  orgName,
  settings,
  draft,
  errors,
  onChange,
}: {
  readonly orgId: string;
  readonly orgName: string;
  readonly settings: AiSettingsDto;
  readonly draft: AiDraft;
  readonly errors: Partial<Record<DraftField, string>>;
  readonly onChange: (patch: Partial<AiDraft>) => void;
}) {
  const { t } = useTranslation('orgAi');
  const listId = useId();
  const presetsId = useId();
  const testHintId = useId();
  const test = useTestAiSettings(orgId);
  const [last, setLast] = useState<LastTest | null>(null);
  const [allowing, setAllowing] = useState<string | null>(null);
  const preset = presetOf(draft.baseUrl);
  const host = displayHostOf(draft.baseUrl.trim());
  const models = last?.result.models ?? [];
  const canTest =
    host !== null &&
    draft.model.trim() !== '' &&
    errors.baseUrl === undefined &&
    errors.model === undefined &&
    errors.key === undefined;
  const lastView = last === null ? null : testViewOf(last.result);
  const lastHost = last === null ? '' : (displayHostOf(last.baseUrl) ?? last.baseUrl);
  const announce =
    lastView === null
      ? ''
      : lastView.ok
        ? t('test.ok', { host: lastHost })
        : lastView.blocked
          ? t('test.blocked.title', { host: lastHost })
          : t(`test.failure.${lastView.failure ?? 'unknown'}`);
  const runTest = () => {
    if (!canTest || test.isPending) return;
    const tried = { baseUrl: draft.baseUrl.trim(), model: draft.model.trim() };
    setLast(null);
    test.mutate(testRequestOf(settings, draft), {
      onSuccess: (result) => {
        setLast({ result, ...tried });
      },
    });
  };

  return (
    <SettingsSection
      data-testid="ai-provider"
      title={t('provider.title')}
      description={t('provider.description')}
    >
      <div className="flex flex-col gap-2">
        <span id={presetsId} className="text-label text-fg">
          {t('provider.presets')}
        </span>
        <div role="group" aria-labelledby={presetsId} className="flex flex-wrap gap-2">
          {PROVIDER_PRESETS.map((item) => (
            <Button
              key={item.id}
              variant="secondary"
              size="sm"
              aria-pressed={preset === item.id}
              data-testid={`ai-preset-${item.id}`}
              className={cn(
                'max-lg:h-control',
                preset === item.id && 'border-accent bg-accent-soft text-fg',
              )}
              onClick={() => {
                onChange({ baseUrl: item.url });
              }}
            >
              {t(`provider.preset.${item.id}`)}
            </Button>
          ))}
        </div>
      </div>
      <FormField
        label={t('provider.baseUrl')}
        hint={t('provider.baseUrlHint')}
        error={errors.baseUrl}
      >
        {(control) => (
          <Input
            {...control}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            data-testid="ai-base-url"
            value={draft.baseUrl}
            onChange={(event) => {
              onChange({ baseUrl: event.target.value });
            }}
          />
        )}
      </FormField>
      {preset === 'anthropic' ||
      preset === 'ollama' ||
      preset === 'vllm' ||
      preset === 'litellm' ? (
        <div className="motion-safe:animate-reveal" data-testid="ai-preset-note">
          <NoteBox tone="neutral" icon={<Info />}>
            {t(
              preset === 'anthropic'
                ? 'provider.presetNote.anthropic'
                : 'provider.presetNote.local',
            )}
          </NoteBox>
        </div>
      ) : null}
      <FormField
        label={t('provider.model')}
        hint={
          models.length > 0
            ? t('provider.modelsFound', { count: models.length })
            : t('provider.modelHint')
        }
        error={errors.model}
      >
        {(control) => (
          <Input
            {...control}
            list={models.length > 0 ? listId : undefined}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            data-testid="ai-model"
            value={draft.model}
            onChange={(event) => {
              onChange({ model: event.target.value });
            }}
          />
        )}
      </FormField>
      {models.length > 0 ? (
        <datalist id={listId}>
          {models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      ) : null}
      <KeyField settings={settings} draft={draft} error={errors.key} onChange={onChange} />

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button
            variant="secondary"
            data-testid="ai-test"
            disabled={!canTest || test.isPending}
            aria-describedby={testHintId}
            className="max-sm:w-full"
            onClick={runTest}
          >
            {test.isPending ? <Spinner /> : <PlugZap aria-hidden="true" />}
            {test.isPending ? t('provider.testing') : t('provider.test')}
          </Button>
          <span id={testHintId} className="text-label font-normal text-fg-muted">
            {canTest
              ? t('provider.testHint', { tokens: AI_TEST_MAX_OUTPUT_TOKENS })
              : t('provider.testNeeds')}
          </span>
        </div>
        {/* One short line is announced; the result card, with its buttons, stays out of the live region. */}
        <p role="status" className="sr-only" data-testid="ai-test-announce">
          {test.isPending ? t('test.running', { host: host ?? '' }) : announce}
        </p>
        <div className="flex flex-col gap-2" data-testid="ai-test-status">
          {test.isPending ? (
            <div
              className="flex flex-col gap-2 rounded-lg border border-line px-3 py-2.5"
              data-testid="ai-test-running"
            >
              <span className="flex items-center gap-2 text-label font-normal text-fg-muted">
                <Spinner className="size-3.5" />
                {t('test.running', { host: host ?? '' })}
              </span>
              <Skeleton className="h-3 w-56 max-w-full" />
              <Skeleton className="h-3 w-40 max-w-full" />
            </div>
          ) : last !== null ? (
            <TestResult
              orgId={orgId}
              result={last.result}
              baseUrl={last.baseUrl}
              model={last.model}
              onAllow={setAllowing}
            />
          ) : null}
        </div>
        {test.isError ? <ErrorAlert error={test.error} /> : null}
      </div>
      {allowing === null ? null : (
        <AllowDialog
          orgId={orgId}
          orgName={orgName}
          pattern={allowing}
          onClose={() => {
            setAllowing(null);
          }}
          onAdded={() => {
            setAllowing(null);
            runTest();
          }}
        />
      )}
    </SettingsSection>
  );
}
