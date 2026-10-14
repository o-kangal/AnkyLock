/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Blind relay WebSocket endpoint, from apps/desktop/.env.local. */
  readonly VITE_RELAY_URL?: string;
}
