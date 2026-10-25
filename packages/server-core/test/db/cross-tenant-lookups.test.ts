import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as lookups from '../../src/db/cross-tenant-lookups.js';
import { TENANT_TABLES } from '../../src/db/tables.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'migrations') files.push(...(await sourceFiles(path)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('cross-tenant lookups (AGENTS.md rule 5, SPEC §14.1)', () => {
  it('exports exactly the reviewed cross-tenant queries', () => {
    // Adding a cross-tenant query is a deliberate decision: update this list,
    // SPEC §14.1 and the review notes together.
    expect(Object.keys(lookups).sort()).toEqual([
      'FINISHED_JOB_RETENTION_DAYS',
      'MAINTENANCE_DELETE_BATCH',
      'createMonthlyPartition',
      'dropMonthlyPartitionsBefore',
      'findApiTokenByHash',
      'findIncomingWebhookByTokenHash',
      'findInvitationOrganization',
      'findShareLinkOrganization',
      'findTelegramWebhookByPathHash',
      'listDateReminderFields',
      'listExpiredAttachments',
      'listExpiredEmailAssets',
      'listExpiredExportFiles',
      'listExpiredFieldConversions',
      'listExpiredFormCovers',
      'listExpiredImportUploads',
      'listExpiredTrashedTables',
      'listMembershipsOfUser',
      'listOrganizationsWithExpiredAutomationRuns',
      'listOrganizationsWithPendingTelegramLinks',
      'listOrganizationsWithTables',
      'listPendingEmailRecipients',
      'listStaleNotificationBuffers',
      'listStuckHttpDeliveries',
      'listTelegramBotsForSparsePoll',
      'listTelegramWebhooksToCheck',
      'listTimeTriggerAutomations',
      'lockUserMemberships',
      'measureHttpDeliveryBacklog',
      'purgeExpiredNotifications',
      'purgeExpiredOperationalRows',
    ]);
  });

  it('no GlobalRepository touches a tenant table', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const source = await readFile(file, 'utf8');
      if (!source.includes('extends GlobalRepository')) continue;
      for (const table of TENANT_TABLES) {
        if (new RegExp(`meta\\.${table}\\b`).test(source)) offenders.push(`${file}: ${table}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
