import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { EpochMs } from '@ankylock/core';
import { AuthError, type AuthErrorCode, type AuthTokens, type AuthTransport } from '@ankylock/sync';

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const isSession = (v: unknown): v is { idToken: string; accessToken: string; expiresAt: number } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { idToken?: unknown }).idToken === 'string' &&
  typeof (v as { accessToken?: unknown }).accessToken === 'string' &&
  typeof (v as { expiresAt?: unknown }).expiresAt === 'number';

const CODES: readonly AuthErrorCode[] = ['ERR_AUTH', 'ERR_AUTH_EXPIRED', 'ERR_NETWORK'];

function toAuthError(error: unknown): AuthError {
  const { code, message } = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  const known = CODES.find((c) => c === code) ?? 'ERR_AUTH';
  return new AuthError(known, typeof message === 'string' ? message : typeof error === 'string' ? error : 'Google sign-in failed.');
}

const toTokens = (session: { idToken: string; accessToken: string; expiresAt: number }): AuthTokens => ({
  idToken: session.idToken,
  accessToken: session.accessToken,
  expiresAt: session.expiresAt as EpochMs,
});

/**
 * Desktop Google sign-in over Tauri IPC. The Rust host runs the PKCE loopback flow and keeps the
 * refresh token in the OS keychain; only short-lived tokens cross into the WebView.
 */
export function createTauriAuthTransport(invoke: Invoke = tauriInvoke): AuthTransport {
  async function call(command: string): Promise<unknown> {
    try {
      return await invoke(command);
    } catch (error) {
      throw toAuthError(error);
    }
  }

  async function session(command: string): Promise<AuthTokens> {
    const raw = await call(command);
    if (!isSession(raw)) throw new AuthError('ERR_AUTH', `Unexpected response from ${command}.`);
    return toTokens(raw);
  }

  return {
    signIn: () => session('oauth_sign_in'),
    refresh: () => session('oauth_refresh'),
    async restore() {
      const raw = await call('oauth_restore');
      if (raw === null) return null;
      if (!isSession(raw)) throw new AuthError('ERR_AUTH', 'Unexpected response from oauth_restore.');
      return toTokens(raw);
    },
    async signOut() {
      await call('oauth_sign_out');
    },
  };
}
