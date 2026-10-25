import {
  DEFAULT_PUBLIC_SHARING,
  publicSharingPolicySchema,
  type PublicSharingPolicy,
} from '@cellhive/contracts';

import type { JsonValue } from '@cellhive/server-core';

/**
 * `organizations.settings.public_sharing` (CONTRACTS §16): whether links
 * with `audience = public` may work in the organization. A missing or
 * unreadable value is the default, `allowed`.
 */
export function publicSharingPolicyOf(settings: JsonValue): PublicSharingPolicy {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return DEFAULT_PUBLIC_SHARING;
  }
  const parsed = publicSharingPolicySchema.safeParse(settings['public_sharing']);
  return parsed.success ? parsed.data : DEFAULT_PUBLIC_SHARING;
}
