import {
  EMAIL_FOOTER_NOT_ALLOWED,
  EMAIL_IDENTITY_NOT_USABLE,
  type AutomationAction,
  type AutomationBranchAction,
  type AutomationDefinition,
  type EmailInstanceFooterPolicy,
  type Id,
  type ProblemErrorItem,
  type SendEmailConfig,
} from '@cellhive/contracts';

import { resolveFooter, type FooterSender } from '../../../mail/footer/footer.js';
import { identityModeOf } from '../../../mail/identities/sender.js';
import { flattenActions } from '../../definition/validate.js';

import type { MailConfig } from '../../../config/load-config.js';
import type { OrgScope } from '../../../db/repository.js';
import type { EmailIdentitiesRepository } from '../../../mail/identities/email-identities.repository.js';
import type { OrgEmailSettings } from '../../../mail/settings/org-email-settings.js';

/**
 * Save-time checks of `send_email` that need the database (BACKLOG T514,
 * ADR-33 §1, §4) — the rest is `validateAutomationDefinition`:
 * - the sender identity and a Reply-To identity must be `verified` with the
 *   base in their scope; unverified, disabled, out of scope, missing or of
 *   another organization are the same `EMAIL_IDENTITY_NOT_USABLE` (no
 *   existence leak), as is `identity_id: null` while the organization
 *   disabled the system sender (T531);
 * - `footer: none` against the policies or with a sender that must show a
 *   footer (system sender, `on_behalf`) → `EMAIL_FOOTER_NOT_ALLOWED`
 *   (`resolveFooter`, save phase).
 * Problems carry the action's path under `definition.`.
 */

export interface SendEmailSenderCheckDeps {
  readonly identities: EmailIdentitiesRepository;
  readonly mail: MailConfig | null;
  /** `EMAIL_AUTOMATION_FOOTER`. */
  readonly instanceFooterPolicy: EmailInstanceFooterPolicy;
}

type AnyAction = AutomationAction | AutomationBranchAction;

/** The `send_email` steps of a definition with their path. */
export function sendEmailSteps(
  definition: AutomationDefinition,
): { action: Extract<AnyAction, { type: 'send_email' }>; path: string }[] {
  return flattenActions(definition.actions).flatMap(({ action, path }) =>
    action.type === 'send_email' ? [{ action, path }] : [],
  );
}

const notUsable = (path: string): ProblemErrorItem => ({
  path,
  code: EMAIL_IDENTITY_NOT_USABLE,
  message: 'This sender identity cannot be used by automations of this base',
});

/** Problems of one `send_email` configuration at `path` (`…actions[n]`). */
export async function checkSendEmailSender(
  deps: SendEmailSenderCheckDeps,
  scope: OrgScope,
  input: {
    readonly baseId: Id<'bse'>;
    readonly config: SendEmailConfig;
    readonly path: string;
    readonly orgSettings: OrgEmailSettings;
  },
): Promise<ProblemErrorItem[]> {
  const { config, path } = input;
  const errors: ProblemErrorItem[] = [];
  let sender: FooterSender | null = null;
  if (config.identity_id === null) {
    if (input.orgSettings.systemSenderEnabled) sender = { kind: 'system' };
    else errors.push(notUsable(`${path}.config.identity_id`));
  } else {
    const identity = await deps.identities.findUsable(scope, config.identity_id, input.baseId);
    if (identity === undefined) errors.push(notUsable(`${path}.config.identity_id`));
    else {
      sender = {
        kind: 'identity',
        mode: identityModeOf(identity.transport, identity.email, deps.mail),
      };
    }
  }
  if (sender !== null) {
    const footer = resolveFooter({
      requested: config.footer,
      instancePolicy: deps.instanceFooterPolicy,
      orgPolicy: input.orgSettings.footerPolicy,
      sender,
      phase: 'save',
    });
    if (!footer.ok) {
      errors.push({
        path: `${path}.config.footer`,
        code: EMAIL_FOOTER_NOT_ALLOWED,
        message:
          footer.reason === 'policy'
            ? 'The footer policy does not allow removing the footer'
            : 'Only a verified identity sending as itself may send without a footer',
        params: { reason: footer.reason },
      });
    }
  }
  const replyTo = config.reply_to;
  if (replyTo !== null && 'identity_id' in replyTo) {
    const identity = await deps.identities.findUsable(scope, replyTo.identity_id, input.baseId);
    if (identity === undefined) errors.push(notUsable(`${path}.config.reply_to.identity_id`));
  }
  return errors;
}

/** {@link checkSendEmailSender} for every `send_email` step of `definition`. */
export async function checkSendEmailSenders(
  deps: SendEmailSenderCheckDeps,
  scope: OrgScope,
  input: {
    readonly baseId: Id<'bse'>;
    readonly definition: AutomationDefinition;
    readonly orgSettings: OrgEmailSettings;
  },
): Promise<ProblemErrorItem[]> {
  const errors: ProblemErrorItem[] = [];
  for (const { action, path } of sendEmailSteps(input.definition)) {
    errors.push(
      ...(await checkSendEmailSender(deps, scope, {
        baseId: input.baseId,
        config: action.config,
        path,
        orgSettings: input.orgSettings,
      })),
    );
  }
  return errors;
}
