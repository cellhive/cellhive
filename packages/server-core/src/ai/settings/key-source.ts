import { deriveSecretKey, unsealSecret } from '../../auth/secret-box.js';
import { orgScope } from '../../db/repository.js';
import { secretHostPolicyOf } from '../../secrets/allowed-hosts.js';
import { SecretsRepository } from '../../secrets/secrets.repository.js';

import type { Db } from '../../db/create-db.js';
import type { AiKeySource } from '../client.js';
import type { Id } from '@cellhive/contracts';
import type { Buffer } from 'node:buffer';

/**
 * The API key of the AI provider from `meta.secrets` (kind `ai_api_key`,
 * BACKLOG T906, ADR-39 §1): `hosts` reads the allowed hosts without
 * unsealing; `value` unseals only once the client checked the URL against
 * them. A secret of another kind or organization is `null` (`secret_unavailable`).
 */
export function createAiKeySource(db: Db, masterKey: Buffer | string): AiKeySource {
  const secrets = new SecretsRepository(db);
  const key = deriveSecretKey(masterKey, 'org-secret');
  const find = async (organizationId: Id<'org'>, id: Id<'sec'>) => {
    const row = await secrets.findById(orgScope(organizationId), id);
    return row?.kind === 'ai_api_key' ? row : undefined;
  };
  return {
    async hosts(organizationId, secretId) {
      const row = await find(organizationId, secretId);
      return row === undefined ? null : secretHostPolicyOf(row);
    },
    async value(organizationId, secretId) {
      const row = await find(organizationId, secretId);
      if (row === undefined) return null;
      try {
        return unsealSecret(key, row.ciphertext);
      } catch {
        return null;
      }
    },
  };
}

/**
 * A key typed into "Test connection" and not saved: allowed only on the
 * host of the URL it is tried with, like a stored one would be.
 */
export function transientAiKeySource(allowedHost: string, value: string): AiKeySource {
  return {
    hosts: () => Promise.resolve({ allowedHosts: [allowedHost], legacyHostsUntil: null }),
    value: () => Promise.resolve(value),
  };
}
