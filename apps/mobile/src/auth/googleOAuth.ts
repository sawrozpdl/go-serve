/**
 * Native Google Sign-In via @react-native-google-signin/google-signin.
 *
 * The app obtains a Google ID token natively (system account picker — no web
 * popup), then posts it to the backend's /auth/google/native, which verifies
 * the token against the web/Android/iOS client IDs and returns our tokens.
 *
 * Config IDs (set in apps/mobile/.env, inlined at Metro start):
 *   - EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID  → the "server" client ID; the returned
 *     ID token's audience is this. REQUIRED (also used as Android's server id).
 *   - EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID  → iOS only.
 * Android is matched by package name + SHA-1 registered in Google Cloud — no ID
 * is needed in JS for Android.
 */
import {
  GoogleSignin,
  isSuccessResponse,
  isErrorWithCode,
  statusCodes,
} from '@react-native-google-signin/google-signin';
import type { ApiError, TokenResponse } from '@cafe-mgmt/api-types';
import { api } from '../api/client';
import { setTokens } from './tokenStore';
import { armRefreshScheduler } from './sessionKeepAlive';
import { useAuthStore } from '../stores/auth';

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  GoogleSignin.configure({
    webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
    iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
    offlineAccess: false,
  });
  configured = true;
}

export async function startGoogleLogin(): Promise<void> {
  ensureConfigured();
  await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

  let response: Awaited<ReturnType<typeof GoogleSignin.signIn>>;
  try {
    response = await GoogleSignin.signIn();
  } catch (e) {
    if (isErrorWithCode(e) && e.code === statusCodes.SIGN_IN_CANCELLED) {
      const err: ApiError = { status: 0, message: 'Sign-in was cancelled.' };
      throw err;
    }
    throw e;
  }

  if (!isSuccessResponse(response) || !response.data.idToken) {
    const err: ApiError = { status: 0, message: 'Google did not return an ID token.' };
    throw err;
  }

  const tok = await api.post<TokenResponse>('/auth/google/native', {
    id_token: response.data.idToken,
  });
  await setTokens(tok.access_token, tok.refresh_token);
  useAuthStore.getState().onAuthenticated();
  armRefreshScheduler();
}
