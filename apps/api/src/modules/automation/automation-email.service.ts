import {
  AutomationEmailPreviewer,
  type AppConfig,
  type EmailPreviewRequest,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { auditContextOf, type RequestMeta } from '../../common/auth/request-meta.js';
import { requireTokenScope } from '../../common/auth/scope.guard.js';
import { RateLimiter } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG } from '../../common/tokens.js';

import { AutomationService, type Located } from './automation.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type {
  AutomationEmailPreview,
  AutomationEmailPreviewRequest,
  AutomationEmailTestResult,
  Id,
} from '@cellhive/contracts';

/**
 * Preview and "Send a test to me" of a `send_email` step (BACKLOG T514,
 * CONTRACTS §21): for people who manage the automation (`404`/`403` like
 * the other automation routes). The email is rendered with the caller's own
 * permissions on a record they read (`AutomationEmailPreviewer`), never with
 * `run_as`'s. The test goes only to the caller's address, at most
 * `EMAIL_TEST_SEND_PER_MIN` per minute (`429`), audited
 * `automation.test_email_sent` without content.
 */
@Injectable()
export class AutomationEmailService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AutomationService) private readonly automations: AutomationService,
    @Inject(AutomationEmailPreviewer) private readonly previewer: AutomationEmailPreviewer,
    @Inject(RateLimiter) private readonly rateLimiter: RateLimiter,
  ) {}

  async preview(
    principal: Principal,
    automationId: Id<'aut'>,
    actionId: string,
    body: AutomationEmailPreviewRequest,
  ): Promise<AutomationEmailPreview> {
    const located = await this.automations.locate(principal, automationId);
    return this.previewer.preview(
      located.base.org.scope,
      this.requestOf(located, principal, actionId, body),
    );
  }

  async test(
    principal: Principal,
    automationId: Id<'aut'>,
    actionId: string,
    body: AutomationEmailPreviewRequest,
    meta: RequestMeta,
  ): Promise<AutomationEmailTestResult> {
    const located = await this.automations.locate(principal, automationId);
    await this.rateLimiter.hit(`automation-email-test:${principal.userId}`, {
      limit: this.config.email.testSendsPerMinute,
      windowSeconds: 60,
    });
    return this.previewer.sendTest(
      located.base.org.scope,
      this.requestOf(located, principal, actionId, body),
      { email: principal.user.email },
      auditContextOf(meta, { type: 'user', id: principal.userId }),
    );
  }

  private requestOf(
    located: Located,
    principal: Principal,
    actionId: string,
    body: AutomationEmailPreviewRequest,
  ): EmailPreviewRequest {
    const { row } = located;
    // Rendering a record shows its values: through an API token, that is `records:read`
    // too (`automations:write` never implies it, CONTRACTS §26.2 — QA S6).
    if (body.record_id !== null) requireTokenScope(principal, 'records:read');
    return {
      automation: {
        id: row.id,
        base_id: row.base_id,
        name: row.name,
        definition: row.definition,
        trigger_table_id: row.trigger_table_id,
      },
      actionId,
      ...(body.draft === undefined ? {} : { draft: body.draft }),
      recordId: body.record_id,
      editorUserId: principal.userId,
    };
  }
}
