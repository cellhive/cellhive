import { describe, expect, it } from 'vitest';

import { AUTOMATION_STEP_ERROR_CODES } from '../src/automation-runs.js';
import {
  automationActionSchema,
  automationBranchActionSchema,
  SEND_TELEGRAM_STEP_ERROR_CODES,
  sendTelegramConfigSchema,
} from '../src/automations.js';
import { ERROR_STATUS } from '../src/errors.js';
import {
  createSecretRequestSchema,
  secretSchema,
  TELEGRAM_BOT_TOKEN_PATTERN,
  updateSecretRequestSchema,
} from '../src/secrets.js';

const SEC = 'sec_A1b2C3d4E5f6G7h8';
const FLD = 'fld_A1b2C3d4E5f6G7h8';
const BSE = 'bse_A1b2C3d4E5f6G7h8';

describe('send_telegram config (CONTRACTS §21, BACKLOG T516)', () => {
  it('fills the defaults: no digest', () => {
    expect(
      sendTelegramConfigSchema.parse({
        secret_id: SEC,
        chat_id: { literal: '-100123456' },
        text: { template: '✅ {{ [fld_A1b2C3d4E5f6G7h8] }}' },
      }),
    ).toEqual({
      secret_id: SEC,
      chat_id: { literal: '-100123456' },
      text: { template: '✅ {{ [fld_A1b2C3d4E5f6G7h8] }}', digest: null },
    });
  });

  it.each([
    ['a negative number', { literal: -100123456 }, true],
    ['a numeric string', { literal: '123456' }, true],
    ['a channel username', { literal: '@ops_alerts' }, true],
    ['a field', { field: FLD }, true],
    ['an earlier step', { step: 'act_1', path: 'records[0].id' }, true],
    ['free text', { literal: 'Kho Hà Nội' }, false],
    ['an empty literal', { literal: '' }, false],
    ['a template', { template: '{{ [fld_A1b2C3d4E5f6G7h8] }}' }, false],
  ])('chat_id: %s', (_name, chat, ok) => {
    const result = sendTelegramConfigSchema.safeParse({
      secret_id: SEC,
      chat_id: chat,
      text: { template: 'x' },
    });
    expect(result.success).toBe(ok);
  });

  it('refuses a secret id of another kind and an empty text', () => {
    expect(
      sendTelegramConfigSchema.safeParse({
        secret_id: 'eid_A1b2C3d4E5f6G7h8',
        chat_id: { literal: '1' },
        text: { template: 'x' },
      }).success,
    ).toBe(false);
    expect(
      sendTelegramConfigSchema.safeParse({
        secret_id: SEC,
        chat_id: { literal: '1' },
        text: { template: '' },
      }).success,
    ).toBe(false);
  });

  it('is an action at the top level and inside an if branch', () => {
    const action = {
      id: 'act_1',
      type: 'send_telegram',
      config: { secret_id: SEC, chat_id: { literal: '1' }, text: { template: 'x' } },
    };
    expect(automationActionSchema.safeParse(action).success).toBe(true);
    expect(automationBranchActionSchema.safeParse(action).success).toBe(true);
  });

  it('adds its step error codes to the run codes', () => {
    for (const code of SEND_TELEGRAM_STEP_ERROR_CODES) {
      expect(AUTOMATION_STEP_ERROR_CODES).toContain(code);
    }
  });
});

describe('secrets (CONTRACTS §24, BACKLOG T516)', () => {
  it.each([
    ['a BotFather token', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', true],
    ['no bot id', ':AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', false],
    ['too short', '123:abc', false],
    ['spaces', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PA LDsaw', false],
  ])('bot token shape: %s', (_name, token, ok) => {
    expect(TELEGRAM_BOT_TOKEN_PATTERN.test(token)).toBe(ok);
  });

  it('creates with the scope of all bases by default', () => {
    expect(
      createSecretRequestSchema.parse({ kind: 'telegram_bot', name: ' Bot IT ', value: 'x' }),
    ).toEqual({
      kind: 'telegram_bot',
      name: 'Bot IT',
      value: 'x',
      base_scope: 'all',
      base_ids: [],
    });
  });

  it('refuses an empty update and unknown keys', () => {
    expect(updateSecretRequestSchema.safeParse({}).success).toBe(false);
    expect(updateSecretRequestSchema.safeParse({ ciphertext: 'x' }).success).toBe(false);
    expect(updateSecretRequestSchema.safeParse({ base_ids: [BSE] }).success).toBe(true);
  });

  it('has no value in the secret DTO', () => {
    expect(Object.keys(secretSchema.shape)).not.toContain('value');
    expect(Object.keys(secretSchema.shape)).not.toContain('ciphertext');
  });

  it('answers a delete of a secret in use with 409 SECRET_IN_USE', () => {
    expect(ERROR_STATUS.SECRET_IN_USE).toBe(409);
  });
});
