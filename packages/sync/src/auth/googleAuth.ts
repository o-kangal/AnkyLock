import type { EpochMs } from '@ankylock/core';

/** Short-lived Google tokens. They authenticate to the relay and Drive, never to the vault (BR-SEC-03). */
export interface AuthTokens {
  readonly idToken: string;
  readonly accessToken: string;
  readonly expiresAt: EpochMs;
}

export type AuthErrorCode = 'ERR_AUTH' | 'ERR_AUTH_EXPIRED' | 'ERR_NETWORK';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * How a platform talks to Google: Tauri IPC to the Rust host on desktop (refresh token in the
 * OS keychain), Google Identity Services on the web (Task 11d).
 */
export interface AuthTransport {
  /**
   * False when tokens cannot be renewed without the user (the web has no refresh token): the
   * session then turns `stale` at expiry instead of refreshing. Defaults to true.
   */
  readonly canRefresh?: boolean;
  signIn(): Promise<AuthTokens>;
  /** Silent session restore at startup; null when the user isn't signed in. */
  restore(): Promise<AuthTokens | null>;
  refresh(): Promise<AuthTokens>;
  signOut(): Promise<void>;
}

export type AuthState =
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'signing-in' }
  | { readonly kind: 'signed-in' }
  /**
   * Tokens expired and the platform cannot renew them silently (web). A live relay connection
   * keeps working; reconnects and backups wait until the user renews with one click.
   */
  | { readonly kind: 'stale' }
  /** The grant was revoked or expired; local work continues, sync waits for a new sign-in. */
  | { readonly kind: 'expired' };

export interface AuthSession {
  state(): AuthState;
  onChange(listener: (state: AuthState) => void): () => void;
  restore(): Promise<void>;
  /** Resolves with an error message, or null on success. */
  signIn(): Promise<string | null>;
  signOut(): Promise<void>;
  /** Current ID token for the relay (read on every connect); throws when signed out. */
  idToken(): string;
  /** A valid Drive access token, refreshed first when it is about to expire. */
  accessToken(): Promise<string>;
  dispose(): void;
}

export interface AuthSessionOptions {
  readonly now?: () => EpochMs;
  /** Refresh this long before expiry (default 5 minutes). */
  readonly refreshMarginMs?: number;
  /** Delay before retrying a refresh that failed for a transient reason (default 1 minute). */
  readonly retryMs?: number;
  readonly onError?: (error: unknown) => void;
}

const isExpired = (error: unknown): boolean => error instanceof AuthError && error.code === 'ERR_AUTH_EXPIRED';

/** Keeps a Google session fresh: schedules refreshes before expiry and reports state changes. */
export function createAuthSession(transport: AuthTransport, options: AuthSessionOptions = {}): AuthSession {
  const now = options.now ?? ((): EpochMs => Date.now() as EpochMs);
  const margin = options.refreshMarginMs ?? 5 * 60_000;
  const retryMs = options.retryMs ?? 60_000;
  const listeners = new Set<(state: AuthState) => void>();
  let state: AuthState = { kind: 'signed-out' };
  let tokens: AuthTokens | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing: Promise<void> | null = null;

  const setState = (next: AuthState): void => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const schedule = (delay: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), Math.max(0, delay));
  };

  const canRefresh = transport.canRefresh ?? true;

  const accept = (next: AuthTokens): void => {
    tokens = next;
    if (canRefresh) schedule(next.expiresAt - margin - now());
    else {
      clearTimeout(timer);
      timer = setTimeout(() => setState({ kind: 'stale' }), Math.max(0, next.expiresAt - margin - now()));
    }
    if (state.kind !== 'signed-in') setState({ kind: 'signed-in' });
  };

  const drop = (next: AuthState): void => {
    clearTimeout(timer);
    tokens = null;
    setState(next);
  };

  function refresh(): Promise<void> {
    refreshing ??= transport
      .refresh()
      .then(accept, (error: unknown) => {
        if (isExpired(error)) drop({ kind: 'expired' });
        else {
          options.onError?.(error);
          schedule(retryMs);
        }
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  return {
    state: () => state,

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async restore() {
      try {
        const restored = await transport.restore();
        if (restored) accept(restored);
      } catch (error) {
        options.onError?.(error);
      }
    },

    async signIn() {
      const renewing = state.kind === 'stale';
      setState({ kind: 'signing-in' });
      try {
        accept(await transport.signIn());
        return null;
      } catch (error) {
        // A failed renewal keeps the stale session (and its live connection) as it was.
        if (renewing) setState({ kind: 'stale' });
        else drop({ kind: 'signed-out' });
        return error instanceof Error ? error.message : String(error);
      }
    },

    async signOut() {
      drop({ kind: 'signed-out' });
      await transport.signOut();
    },

    idToken() {
      if (!tokens) throw new AuthError('ERR_AUTH', 'Not signed in.');
      return tokens.idToken;
    },

    async accessToken() {
      if (tokens && tokens.expiresAt - margin <= now()) {
        if (!canRefresh) throw new AuthError('ERR_AUTH_EXPIRED', 'Renew Google access to back up.');
        await refresh();
      }
      if (!tokens) throw new AuthError('ERR_AUTH_EXPIRED', 'Not signed in.');
      return tokens.accessToken;
    },

    dispose() {
      clearTimeout(timer);
      listeners.clear();
    },
  };
}
