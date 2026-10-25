import {
  canonicalAllowedHosts,
  isValidSecretValue,
  parseAllowlistPattern,
  SECRET_MAX_ALLOWED_HOSTS,
  type CreateSecretInput,
  type Id,
  type ParsedAllowlistPattern,
  type SecretBaseScope,
  type SecretDto,
  type UpdateSecretRequest,
} from '@cellhive/contracts';

/**
 * The pure part of the organization's integrations page (BACKLOG T613,
 * CONTRACTS §24, §25.4): which secrets are HTTP ones, what the secret form
 * would send (or why not yet), and how an allowlist pattern will be stored.
 */

export const HTTP_SECRET_KINDS = ['http_header', 'webhook_signing'] as const;
export type HttpSecretKind = (typeof HTTP_SECRET_KINDS)[number];

export function isHttpSecret(
  secret: Pick<SecretDto, 'kind'>,
): secret is Pick<SecretDto, 'kind'> & { kind: HttpSecretKind } {
  return (HTTP_SECRET_KINDS as readonly string[]).includes(secret.kind);
}

/** How the value of a secret is set in the form. */
export type ValueMode =
  /** Changing a secret: keep its value. */
  | 'keep'
  /** Type or paste the value. */
  | 'enter'
  /** `webhook_signing` only: the server generates it and shows it once. */
  | 'generate';

export interface SecretFormState {
  readonly kind: HttpSecretKind;
  readonly name: string;
  readonly valueMode: ValueMode;
  readonly value: string;
  readonly baseScope: SecretBaseScope;
  readonly baseIds: readonly string[];
  /** Allowed hosts (T701, T717): the chips, canonical patterns in the order added. */
  readonly allowedHosts: readonly string[];
  /** What is typed in the chip input and not added yet (sent too: it counts as chips). */
  readonly hostDraft: string;
}

export type SecretFormErrors = Partial<
  Record<'name' | 'value' | 'base_ids' | 'allowed_hosts', string>
>;

/**
 * The entries of typed or pasted host text (T717): separated by white space
 * (line breaks of a paste), commas or semicolons — none of which a pattern
 * contains.
 */
export function splitHostInput(text: string): string[] {
  return text.split(/[\s,;]+/u).filter((part) => part !== '');
}

/** What adding typed or pasted text to the chips did (T717). */
export interface HostsAdded {
  /** The chips afterwards. */
  readonly hosts: readonly string[];
  /** Canonical patterns added, in order. */
  readonly added: readonly string[];
  /** Entries already a chip (same canonical form). */
  readonly duplicates: readonly string[];
  /** Entries that are not host patterns (IP, URL, `*.com`…): left in the input. */
  readonly invalid: readonly string[];
  /** Entries left out because the list is full (`SECRET_MAX_ALLOWED_HOSTS`): left in the input. */
  readonly overflow: readonly string[];
}

/**
 * Adds the entries of `text` to the chips as their canonical form (lower
 * case, punycode, no trailing dot — what the server stores, CONTRACTS §24),
 * checked with the allowlist's `parseAllowlistPattern`; duplicates are
 * dropped, invalid entries and those past 20 are returned to stay typed.
 */
export function addHostChips(hosts: readonly string[], text: string): HostsAdded {
  const next = [...hosts];
  const added: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  const overflow: string[] = [];
  for (const entry of splitHostInput(text)) {
    const parsed = parseAllowlistPattern(entry);
    if (parsed === null) invalid.push(entry);
    else if (next.includes(parsed.pattern)) duplicates.push(parsed.pattern);
    else if (next.length >= SECRET_MAX_ALLOWED_HOSTS) overflow.push(entry);
    else {
      next.push(parsed.pattern);
      added.push(parsed.pattern);
    }
  }
  return { hosts: next, added, duplicates, invalid, overflow };
}

/** What the transition period of a secret reads. */
interface LegacyFields {
  readonly kind: SecretDto['kind'];
  readonly allowed_hosts: readonly string[];
  readonly legacy_hosts_until: string | null;
}

/**
 * Where an HTTP secret stored before allowed hosts existed stands (T717,
 * CONTRACTS §24): `pending` — still sent to any host until `until`;
 * `stopped` — the transition period is over, steps using it fail
 * (`secret_host_not_allowed`, `legacy_expired`). `null` for a secret with
 * a list (or a Telegram bot).
 */
export function legacyHostsState(
  secret: LegacyFields,
  now: Date,
): { readonly state: 'pending' | 'stopped'; readonly until: string | null } | null {
  if (!isHttpSecret(secret) || secret.allowed_hosts.length > 0) return null;
  const until = secret.legacy_hosts_until;
  if (until !== null && new Date(until).getTime() > now.getTime()) {
    return { state: 'pending', until };
  }
  return { state: 'stopped', until };
}

/** HTTP secrets without allowed hosts (the page banner, T717): how many, stopped, first deadline. */
export function legacySummary(
  secrets: readonly LegacyFields[],
  now: Date,
): { readonly pending: number; readonly stopped: number; readonly firstUntil: string | null } {
  let pending = 0;
  let stopped = 0;
  let firstUntil: string | null = null;
  for (const secret of secrets) {
    const legacy = legacyHostsState(secret, now);
    if (legacy === null) continue;
    if (legacy.state === 'stopped') {
      stopped += 1;
      continue;
    }
    pending += 1;
    if (legacy.until !== null && (firstUntil === null || legacy.until < firstUntil)) {
      firstUntil = legacy.until;
    }
  }
  return { pending, stopped, firstUntil };
}

export function initialSecretForm(editing: SecretDto | null): SecretFormState {
  if (editing === null) {
    return {
      kind: 'http_header',
      name: '',
      valueMode: 'enter',
      value: '',
      baseScope: 'all',
      baseIds: [],
      allowedHosts: [],
      hostDraft: '',
    };
  }
  return {
    kind: isHttpSecret(editing) ? editing.kind : 'http_header',
    name: editing.name,
    valueMode: 'keep',
    value: '',
    baseScope: editing.base_scope,
    baseIds: editing.base_ids,
    allowedHosts: editing.allowed_hosts,
    hostDraft: '',
  };
}

/**
 * What the form sends, or its problems (codes translated by the page):
 * a name; a value of the right shape when one is entered (CONTRACTS §24 —
 * the server checks again: `INVALID_SECRET_VALUE`); a base when the scope
 * is "selected bases"; 1–20 allowed hosts, each a host pattern (T701,
 * CONTRACTS §24 — `hosts_required`, `hosts_too_many`, `hosts_invalid`). A
 * secret stored before lists existed may keep an empty list (its transition
 * period). Changing a secret sends only what changed.
 */
export function secretRequestOf(
  form: SecretFormState,
  editing: SecretDto | null,
):
  | { readonly ok: true; readonly create: CreateSecretInput }
  | { readonly ok: true; readonly update: UpdateSecretRequest | null }
  | { readonly ok: false; readonly errors: SecretFormErrors } {
  const errors: SecretFormErrors = {};
  const name = form.name.trim();
  const value = form.value.trim();
  if (name === '') errors.name = 'required';
  if (form.valueMode === 'enter') {
    if (value === '') errors.value = 'required';
    else if (!isValidSecretValue(form.kind, value)) errors.value = `format_${form.kind}`;
  }
  if (form.baseScope === 'selected' && form.baseIds.length === 0) errors.base_ids = 'bases';
  // Text still in the chip input is sent too (as the chips it would become).
  const hosts = [...form.allowedHosts, ...splitHostInput(form.hostDraft)];
  const legacy = editing !== null && editing.allowed_hosts.length === 0;
  if (hosts.length === 0) {
    if (!legacy) errors.allowed_hosts = 'hosts_required';
  } else if (hosts.length > SECRET_MAX_ALLOWED_HOSTS) {
    errors.allowed_hosts = 'hosts_too_many';
  } else if (hosts.some((host) => parseAllowlistPattern(host) === null)) {
    errors.allowed_hosts = 'hosts_invalid';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const baseIds = form.baseScope === 'selected' ? (form.baseIds as Id<'bse'>[]) : [];
  const valuePart =
    form.valueMode === 'generate'
      ? { generate: true as const }
      : form.valueMode === 'enter'
        ? { value }
        : {};
  if (editing === null) {
    return {
      ok: true,
      create: {
        kind: form.kind,
        name,
        base_scope: form.baseScope,
        base_ids: baseIds,
        allowed_hosts: hosts,
        ...valuePart,
      },
    };
  }
  const sameHosts =
    hosts.length === 0 ||
    canonicalAllowedHosts(hosts).join('\n') === editing.allowed_hosts.join('\n');
  const sameBases =
    form.baseScope === editing.base_scope &&
    (form.baseScope === 'all' ||
      (baseIds.length === editing.base_ids.length &&
        baseIds.every((base) => editing.base_ids.includes(base))));
  const update: UpdateSecretRequest = {
    ...(name === editing.name ? {} : { name }),
    ...valuePart,
    ...(sameBases ? {} : { base_scope: form.baseScope, base_ids: baseIds }),
    ...(sameHosts ? {} : { allowed_hosts: hosts }),
  };
  return { ok: true, update: Object.keys(update).length === 0 ? null : update };
}

/** How a typed allowlist pattern will be stored, `null` when it is not one (IP, CIDR, `*.com`…). */
export function allowlistPreview(input: string): ParsedAllowlistPattern | null {
  return input.trim() === '' ? null : parseAllowlistPattern(input);
}

/** Whether a rotation of a signing secret is still in its 24-hour overlap at `now`. */
export function rotatingUntil(secret: Pick<SecretDto, 'previous_value_expires_at'>, now: Date) {
  const until = secret.previous_value_expires_at;
  if (until === null) return null;
  return new Date(until).getTime() > now.getTime() ? until : null;
}
