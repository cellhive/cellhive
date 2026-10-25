import {
  acceptInvitationResponseSchema,
  invitationPreviewSchema,
  setupResponseSchema,
  type AcceptInvitationRequest,
  type ForgotPasswordRequest,
  type LoginRequest,
  type PasswordResetRequestInput,
  type SetupRequest,
} from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest, apiRequestVoid } from '../../lib/api/client';
import { keys } from '../../lib/query/keys';

/** Setup, sign-in, password reset and invitations (CONTRACTS §12.0, §12.1, §6). */
export const authApi = {
  setup: (body: SetupRequest) =>
    apiRequest('/setup', setupResponseSchema, { method: 'POST', body }),
  login: (body: LoginRequest) => apiRequestVoid('/auth/login', { method: 'POST', body }),
  forgotPassword: (body: ForgotPasswordRequest) =>
    apiRequestVoid('/auth/forgot-password', { method: 'POST', body }),
  resetPassword: (token: string, body: PasswordResetRequestInput) =>
    apiRequestVoid(`/auth/password-reset/${encodeURIComponent(token)}`, { method: 'POST', body }),
  previewInvitation: (token: string, signal?: AbortSignal) =>
    apiRequest(`/invitations/${encodeURIComponent(token)}`, invitationPreviewSchema, { signal }),
  acceptInvitation: (token: string, body: AcceptInvitationRequest) =>
    apiRequest(`/invitations/${encodeURIComponent(token)}/accept`, acceptInvitationResponseSchema, {
      method: 'POST',
      body,
    }),
};

export const invitationPreviewQuery = (token: string) =>
  queryOptions({
    queryKey: keys.invitation(token),
    queryFn: ({ signal }) => authApi.previewInvitation(token, signal),
    staleTime: 60_000,
  });
