/** Reset links live in server-core: the worker sends forgot-password links too. */
export {
  PasswordResetLinks,
  RESET_LINK_TTL_MS,
  resetUrlOf,
  type ResetLink,
} from '@cellhive/server-core';
