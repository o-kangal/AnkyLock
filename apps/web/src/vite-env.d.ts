/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google OAuth "Web application" client id, from apps/web/.env.local. Unset: local-only. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** Blind relay WebSocket endpoint, from apps/web/.env.local. */
  readonly VITE_RELAY_URL?: string;
}
