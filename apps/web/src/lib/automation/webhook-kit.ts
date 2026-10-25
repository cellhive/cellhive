/**
 * The parts of incoming webhook management (T611, `features/integrations`)
 * the automation builder's `webhook.received` trigger (T612,
 * `features/automation`) reuses, given by the route like the condition
 * editor (FRONTEND §1.2): "New webhook" with its secrets shown once, and the
 * read-only URL field with "Copy".
 */

import type { IncomingWebhookWithSecretsDto } from '@cellhive/contracts';
import type { ComponentType, ReactNode } from 'react';

export interface CreateWebhookDialogProps {
  readonly baseId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  /** The hook with the secrets of this call: show them once (`SecretRevealDialog`). */
  readonly onCreated: (hook: IncomingWebhookWithSecretsDto) => void;
}

export interface SecretRevealDialogProps {
  readonly reveal: {
    readonly reason: 'created' | 'rotated' | 'bearer';
    readonly hook: IncomingWebhookWithSecretsDto;
  } | null;
  readonly onDone: () => void;
}

export interface CopyFieldProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: ReactNode;
  readonly 'data-testid'?: string;
}

export interface WebhookKit {
  readonly CreateWebhookDialog: ComponentType<CreateWebhookDialogProps>;
  readonly SecretRevealDialog: ComponentType<SecretRevealDialogProps>;
  readonly CopyField: ComponentType<CopyFieldProps>;
}
