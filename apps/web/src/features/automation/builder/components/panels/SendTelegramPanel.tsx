import { Select } from '@cellhive/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { secretsApi } from '../../../../../lib/api/secrets';
import { keys } from '../../../../../lib/query/keys';
import { NO_SECRET } from '../../model/draft';
import { templateOf } from '../../model/values';
import { useBuilderEnv } from '../env';
import { ValueInput } from '../values/ValueInput';

import { Note, PanelField } from './common';

import type { ActionPanelProps } from './ActionPanels';
import type { AutomationValue, Id, TelegramChatValue } from '@cellhive/contracts';

const NO_BOTS_NOTE = 'telegram-no-bots';
const CHAT_INPUT = 'telegram-chat';
const TEXT_INPUT = 'telegram-text';

const PATH = {
  secret: 'config.secret_id',
  chat: 'config.chat_id',
  text: 'config.text.template',
} as const;

/** The text value shown in the template field (a literal without chips becomes its template). */
function textValue(template: string): AutomationValue | undefined {
  return template === '' ? undefined : { template };
}

function templateFrom(value: AutomationValue | undefined): string {
  if (value === undefined) return '';
  if ('template' in value) return value.template;
  if ('literal' in value && typeof value.literal === 'string') {
    return templateOf([{ kind: 'text', text: value.literal }]);
  }
  return '';
}

/** A chat value from the picker: a literal (trimmed), a field or a step; anything else clears it. */
function chatFrom(value: AutomationValue | undefined): TelegramChatValue {
  if (value === undefined) return { literal: '' };
  if ('field' in value || 'step' in value) return value;
  if (
    'literal' in value &&
    (typeof value.literal === 'string' || typeof value.literal === 'number')
  ) {
    return { literal: typeof value.literal === 'string' ? value.literal.trim() : value.literal };
  }
  return { literal: '' };
}

/**
 * `send_telegram` (BACKLOG T516, CONTRACTS §21): an organization bot shared
 * with this base, chosen by name (`GET /bases/:id/secrets` — never the
 * token), the chat id (literal, field or earlier step) and the text with
 * chips. Telegram HTML: what is typed is kept, every inserted value is
 * escaped. A `digest` set elsewhere is kept as is (its editor is T522).
 */
export function SendTelegramPanel({ action, scope, onChange }: ActionPanelProps<'send_telegram'>) {
  const { t } = useTranslation('automationBuilder');
  const env = useBuilderEnv();
  const step = action.id as `act_${string}`;
  const { config } = action;
  const bots = useQuery({
    queryKey: keys.baseSecrets(env.base.id, 'telegram_bot'),
    queryFn: ({ signal }) => secretsApi.base(env.base.id, 'telegram_bot', signal),
    staleTime: 30_000,
  });
  const items = bots.data?.items ?? [];
  const known = config.secret_id === NO_SECRET || items.some((bot) => bot.id === config.secret_id);
  const set = (patch: Partial<typeof config>) => {
    onChange({ ...action, config: { ...config, ...patch } });
  };

  return (
    <div className="flex flex-col gap-4">
      <PanelField label={t('telegram.bot')} step={step} path={PATH.secret}>
        {(control) => (
          <Select
            {...control}
            value={config.secret_id}
            disabled={bots.isPending}
            data-testid="telegram-bot"
            onChange={(event) => {
              set({ secret_id: event.target.value as Id<'sec'> });
            }}
          >
            <option value="">{t('values.choose')}</option>
            {items.map((bot) => (
              <option key={bot.id} value={bot.id}>
                {bot.name}
              </option>
            ))}
            {known || bots.isPending ? null : (
              <option value={config.secret_id}>{t('telegram.unknownBot')}</option>
            )}
          </Select>
        )}
      </PanelField>
      {bots.isSuccess && items.length === 0 ? (
        <Note tone="warning" title={t('telegram.noBotsTitle')} testId={NO_BOTS_NOTE}>
          {t('telegram.noBots')}
        </Note>
      ) : null}
      <PanelField
        label={t('telegram.chat')}
        step={step}
        path={PATH.chat}
        hint={t('telegram.chatHint')}
      >
        {(control) => (
          <ValueInput
            value={
              'literal' in config.chat_id && config.chat_id.literal === ''
                ? undefined
                : config.chat_id
            }
            onChange={(value) => {
              set({ chat_id: chatFrom(value) });
            }}
            field={null}
            allowTemplate={false}
            scope={scope}
            label={t('telegram.chat')}
            invalid={control['aria-invalid']}
            describedBy={control['aria-describedby']}
            testId={CHAT_INPUT}
          />
        )}
      </PanelField>
      <PanelField
        label={t('telegram.text')}
        step={step}
        path={PATH.text}
        hint={t('telegram.textHint')}
      >
        {(control) => (
          <ValueInput
            value={textValue(config.text.template)}
            onChange={(value) => {
              set({ text: { ...config.text, template: templateFrom(value) } });
            }}
            field={null}
            allowTemplate
            multiline
            scope={scope}
            label={t('telegram.text')}
            invalid={control['aria-invalid']}
            describedBy={control['aria-describedby']}
            testId={TEXT_INPUT}
          />
        )}
      </PanelField>
      {config.text.digest === null ? null : <Note>{t('telegram.digestKept')}</Note>}
    </div>
  );
}
