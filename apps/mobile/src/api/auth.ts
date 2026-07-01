/**
 * Auth React Query hooks. Thin wrappers over the token-aware `api` client that
 * also drive the token store + auth guard on login/logout.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthConfig, Me, RequestOTPResponse, TokenResponse } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { getRefreshToken, setTokens } from '../auth/tokenStore';
import { armRefreshScheduler } from '../auth/sessionKeepAlive';
import { useAuthStore } from '../stores/auth';
import { useTenantStore } from '../stores/tenant';

/** Which login methods the server has mounted (Google / OTP / dev). */
export function useAuthConfig() {
  return useQuery({
    queryKey: qk.authConfig,
    queryFn: () => api.get<AuthConfig>('/auth/config'),
    staleTime: Infinity,
  });
}

/** Current user + memberships + active-tenant permissions. */
export function useMe() {
  const slug = useTenantStore((s) => s.active?.slug);
  const hasSession = useAuthStore((s) => s.hasSession);
  return useQuery({
    queryKey: qk.me(slug),
    queryFn: () => api.get<Me>('/v1/me', { tenantSlug: slug }),
    enabled: hasSession,
  });
}

export function useRequestOTP() {
  return useMutation({
    mutationFn: (email: string) => api.post<RequestOTPResponse>('/auth/request-otp', { email }),
  });
}

/** Persist tokens + flip the auth guard on a successful login. */
function useLoginMutation<V>(fn: (vars: V) => Promise<TokenResponse>) {
  const qc = useQueryClient();
  const onAuthenticated = useAuthStore((s) => s.onAuthenticated);
  return useMutation({
    mutationFn: async (vars: V) => {
      const tok = await fn(vars);
      await setTokens(tok.access_token, tok.refresh_token);
      return tok;
    },
    onSuccess: () => {
      onAuthenticated();
      armRefreshScheduler();
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useVerifyOTP() {
  return useLoginMutation((vars: { email: string; code: string }) =>
    api.post<TokenResponse>('/auth/verify-otp', vars),
  );
}

/** Exchange a Google one-time handoff code for tokens. */
export function useExchangeCode() {
  return useLoginMutation((code: string) => api.post<TokenResponse>('/auth/exchange', { code }));
}

/** Dev-only email/name login (enabled server-side only in dev). */
export function useDevLogin() {
  return useLoginMutation((vars: { email: string; name: string }) =>
    api.post<TokenResponse>('/auth/dev-login', vars),
  );
}

export function useLogout() {
  const qc = useQueryClient();
  const signOut = useAuthStore((s) => s.signOut);
  return useMutation({
    mutationFn: async () => {
      // Best-effort server revoke; local sign-out always proceeds.
      try {
        await api.post('/auth/logout', { refresh_token: getRefreshToken() });
      } catch {
        /* ignore — we clear locally regardless */
      }
      await signOut();
      qc.clear();
    },
  });
}
