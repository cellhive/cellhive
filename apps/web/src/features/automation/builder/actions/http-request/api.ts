import {
  httpDeliveryResultSchema,
  httpTestAcceptedSchema,
  type HttpRequestConfig,
  type RunN8nWorkflowConfig,
  type SecretKind,
} from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest } from '../../../../../lib/api/client';
import { secretsApi } from '../../../../../lib/api/secrets';
import { keys } from '../../../../../lib/query/keys';

const id = encodeURIComponent;

/**
 * "Send a test" of an `http_request` or `run_n8n_workflow` step (CONTRACTS
 * §25.5, BACKLOG T606, T616): `202 { delivery_id, warnings }`, then the
 * delivery is read until it ends — only by the person who sent it.
 */
export const httpTestApi = {
  send: (
    automationId: string,
    actionId: string,
    body: {
      readonly record_id: string | null;
      readonly draft: HttpRequestConfig | RunN8nWorkflowConfig;
    },
  ) =>
    apiRequest(
      `/automations/${id(automationId)}/actions/${id(actionId)}/http-test`,
      httpTestAcceptedSchema,
      { method: 'POST', body },
    ),
  delivery: (deliveryId: string, signal?: AbortSignal) =>
    apiRequest(`/http-deliveries/${id(deliveryId)}`, httpDeliveryResultSchema, { signal }),
};

/** Secrets of `kind` an automation of the base may use, by name (never a value). */
export const baseSecretsQuery = (baseId: string, kind: SecretKind) =>
  queryOptions({
    queryKey: keys.baseSecrets(baseId, kind),
    queryFn: ({ signal }) => secretsApi.base(baseId, kind, signal),
    staleTime: 30_000,
  });
