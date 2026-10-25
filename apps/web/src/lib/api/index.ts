import { basesApi } from './bases';
import { jobsApi } from './jobs';
import { orgsApi } from './orgs';
import { recordsApi } from './records';
import { fieldsApi, tablesApi } from './tables';
import { viewsApi } from './views';

/**
 * Typed endpoint functions shared by several features (FRONTEND §3.1):
 * `api.records.query(tableId, body, { signal })`. Request and response
 * types come from `@cellhive/contracts`; components never call `fetch`.
 * Screens owned by a single feature (auth, org navigation) keep their
 * endpoints in `features/<name>/api.ts`.
 *
 * Everything here loads with the app shell (FRONTEND §11.1, working cap
 * 285 KB, T700), so `api` only holds what the shell itself calls on a first
 * load: the session's organizations and bases, the tables, fields and views
 * of the route guards and sidebar, record counts and jobs of the realtime
 * client. Their response schemas are behind `DEV ?` (checked in development,
 * cast in production) so that zod stays out of the shell. Every other API —
 * roles (`./roles`, `lib/query/roles.ts`), record tree (`./record-tree`),
 * buttons (`./buttons`), automations, secrets, webhooks, and new ones — is
 * imported from its own module by the lazy screens that use it, never
 * added here.
 */
export const api = {
  bases: basesApi,
  tables: tablesApi,
  fields: fieldsApi,
  records: recordsApi,
  jobs: jobsApi,
  orgs: orgsApi,
  views: viewsApi,
};

export type {
  CreateAutomationBody,
  UpdateAutomationBody,
  ValidateTemplateBody,
} from './automations';
export type { CreateViewBody } from './views';
export type {
  CursorOptions,
  NewRecord,
  ReadOptions,
  RecordQueryBody,
  WriteOptions,
} from './records';
export type { RecordTreeBody, RecordTreeLevel } from './record-tree';
