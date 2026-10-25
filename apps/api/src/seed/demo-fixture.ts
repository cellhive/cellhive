import type { OrgRole } from '@cellhive/server-core';

/**
 * The demo data of `pnpm seed:demo` (CONTRACTS §9): the users of the
 * permission fixture (CONTRACTS §5) with Vietnamese display names, one
 * organization, the `Sales` group, a workspace, the base "Chăm sóc khách
 * hàng" with its tables (`demo-tables.ts`), sample automations
 * (`demo-automations.ts`, T519) and the custom `Sales` role. The dashboard
 * comes with the task that adds it.
 */

/** Development-only password of every demo user (CONTRACTS §9). Never used in production. */
export const DEMO_PASSWORD = 'Cellhive-demo-2026';

export const DEMO_EMAIL_DOMAIN = 'demo.cellhive.local';

export const DEMO_ORG = {
  name: 'Cellhive Demo',
  settings: { locale: 'vi', timezone: 'Asia/Ho_Chi_Minh', currency: 'VND' },
} as const;

export const DEMO_WORKSPACE_NAME = 'Kinh doanh';

export const DEMO_BASE = {
  name: 'Chăm sóc khách hàng',
  icon: 'headset',
  description: 'Dữ liệu mẫu: khách hàng, phiếu hỗ trợ và đơn hàng.',
} as const;

export const DEMO_GROUP_NAME = 'Sales';

/** Custom base role of CONTRACTS §5, given to the group `Sales`. */
export const DEMO_SALES_ROLE_NAME = 'Sales';

/** Key of a demo user in the permission fixture (CONTRACTS §5). */
export type DemoUserKey = 'u_admin' | 'u_editor' | 'u_reader' | 'u_sales1' | 'u_sales2' | 'u_out';

/** Base system role a demo user gets directly (the Sales group's role comes with T109). */
export type DemoBaseRole = 'editor' | 'reader';

export interface DemoUser {
  readonly key: DemoUserKey;
  readonly email: string;
  readonly displayName: string;
  /** Organization role; `u_admin` creates the organization and is its owner. */
  readonly orgRole: OrgRole;
  /** Joins the demo workspace as a `member` directly. */
  readonly workspaceMember: boolean;
  readonly baseRole: DemoBaseRole | null;
  readonly inSalesGroup: boolean;
  /** Tickets and orders are assigned to (owned by) this user. */
  readonly assignee: boolean;
  /** What the user is for, printed in the summary. */
  readonly note: string;
}

/**
 * Which demo organization a run creates (BACKLOG T800): by default the
 * documented one (CONTRACTS §9). The E2E suite seeds one more per
 * Playwright worker, side by side on the same instance: its own name and a
 * plus-address tag on every email (`admin+w0@demo.cellhive.local`).
 */
export interface DemoProfile {
  /** Name of the organization (its slug is derived from it). */
  readonly orgName: string;
  /** Plus-address tag of every demo email, or `null` for the documented addresses. */
  readonly emailTag: string | null;
}

export const DEFAULT_DEMO_PROFILE: DemoProfile = { orgName: DEMO_ORG.name, emailTag: null };

/** A tag for {@link DemoProfile.emailTag}: lower-case letters, digits and dashes. */
export const DEMO_EMAIL_TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

function email(localPart: string, tag: string | null = null): string {
  return `${localPart}${tag === null ? '' : `+${tag}`}@${DEMO_EMAIL_DOMAIN}`;
}

export const DEMO_USERS: readonly DemoUser[] = [
  {
    key: 'u_admin',
    email: email('admin'),
    displayName: 'Nguyễn Minh Anh',
    orgRole: 'owner',
    workspaceMember: false,
    baseRole: null,
    inSalesGroup: false,
    assignee: false,
    note: 'org owner/admin, base owner',
  },
  {
    key: 'u_editor',
    email: email('editor'),
    displayName: 'Trần Thu Hà',
    orgRole: 'member',
    workspaceMember: true,
    baseRole: 'editor',
    inSalesGroup: false,
    assignee: true,
    note: 'base role Editor',
  },
  {
    key: 'u_reader',
    email: email('reader'),
    displayName: 'Lê Quốc Bảo',
    orgRole: 'member',
    workspaceMember: true,
    baseRole: 'reader',
    inSalesGroup: false,
    assignee: false,
    note: 'base role Reader',
  },
  {
    key: 'u_sales1',
    email: email('sales1'),
    displayName: 'Phạm Ngọc Lan',
    orgRole: 'member',
    workspaceMember: false,
    baseRole: null,
    inSalesGroup: true,
    assignee: true,
    note: 'group Sales: custom role Sales',
  },
  {
    key: 'u_sales2',
    email: email('sales2'),
    displayName: 'Võ Đức Huy',
    orgRole: 'member',
    workspaceMember: false,
    baseRole: null,
    inSalesGroup: true,
    assignee: true,
    note: 'group Sales: custom role Sales',
  },
  {
    key: 'u_out',
    email: email('out'),
    displayName: 'Đặng Thanh Tùng',
    orgRole: 'member',
    workspaceMember: false,
    baseRole: null,
    inSalesGroup: false,
    assignee: false,
    note: 'org member, no base role',
  },
];

/** The demo users of `profile`: {@link DEMO_USERS} with the profile's email tag. */
export function demoUsersOf(profile: DemoProfile): readonly DemoUser[] {
  if (profile.emailTag === null) return DEMO_USERS;
  const tag = profile.emailTag;
  return DEMO_USERS.map((user) => ({
    ...user,
    email: email(user.email.slice(0, user.email.indexOf('@')), tag),
  }));
}
