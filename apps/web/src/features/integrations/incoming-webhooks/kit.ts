import { CreateWebhookDialog } from './components/CreateWebhookDialog';
import { CopyField } from './components/parts';
import { SecretRevealDialog } from './components/SecretRevealDialog';

import type { WebhookKit } from '../../../lib/automation/webhook-kit';

/**
 * What the automation builder's `webhook.received` trigger (T612) reuses
 * from this feature, handed over by the route (FRONTEND §1.2): "New
 * webhook", the secrets shown once, the URL field with "Copy".
 */
export const webhookKit: WebhookKit = { CreateWebhookDialog, SecretRevealDialog, CopyField };
