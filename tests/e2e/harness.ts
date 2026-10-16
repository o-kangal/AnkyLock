import { IDBFactory } from 'fake-indexeddb';
import type { EpochMs, NoteId, VaultId } from '@ankylock/core';
import { CryptoError, createKeySealer, type WorkerSealer } from '@ankylock/crypto';
import { WebVaultDirectory } from '@ankylock/storage';
import { AuthError, TEXT_FIELD, createAuthSession, type AuthTransport, type SocketLike } from '@ankylock/sync';
import { createRuntime, type Runtime } from '@ankylock/web/workspace';

export const PASSPHRASE = 'correct horse battery staple';

/**
 * In-memory blind relay: fans binary frames out to the other open sockets of the same vault URL,
 * like the Rust relay. It records every frame so tests can check that only ciphertext crossed it.
 */
export class MockRelay {
  readonly sockets = new Set<MockSocket>();
  readonly frames: Uint8Array[] = [];

  forward(from: MockSocket, data: Uint8Array): void {
    this.frames.push(data.slice());
    for (const socket of this.sockets) {
      if (socket !== from && socket.url === from.url && socket.readyState === 1) socket.deliver(data);
    }
  }

  /** Everything the relay saw, decoded as text (frames are JSON envelopes around base64 ciphertext). */
  seen(): string {
    return this.frames.map((f) => new TextDecoder().decode(f)).join('\n');
  }
}

export class MockSocket implements SocketLike {
  binaryType: BinaryType = 'blob';
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(
    readonly relay: MockRelay,
    readonly url: string,
    online: boolean,
  ) {
    queueMicrotask(() => {
      if (!online) {
        // No network: the client sees the connection fail and retries with backoff.
        this.readyState = 3;
        this.onclose?.(new CloseEvent('close'));
        return;
      }
      relay.sockets.add(this);
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    });
  }

  send(data: Uint8Array | string): void {
    if (typeof data !== 'string') this.relay.forward(this, data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.relay.sockets.delete(this);
  }

  /** The network goes away under an open connection. */
  drop(): void {
    this.close();
    this.onclose?.(new CloseEvent('close'));
  }

  deliver(data: Uint8Array): void {
    this.onmessage?.({ data: data.slice().buffer } as MessageEvent);
  }
}

/** Google sign-in that always succeeds, without a network (tokens are opaque to the mock relay). */
function fakeGoogle(): AuthTransport {
  return {
    signIn: async () => ({ idToken: 'id-token', accessToken: 'access-token', expiresAt: (Date.now() + 3_600_000) as EpochMs }),
    restore: async () => null,
    refresh: () => Promise.reject(new AuthError('ERR_AUTH_EXPIRED', 'expired')),
    signOut: async () => undefined,
  };
}

/** Same-thread stand-in for the crypto worker; the real AES-GCM code runs, just not in a Worker. */
function localSealer(): WorkerSealer {
  let current: CryptoKey | null = null;
  const inner = createKeySealer(() => {
    if (!current) throw new CryptoError('ERR_VAULT_LOCKED', 'The vault is locked.');
    return current;
  });
  return { ...inner, setKey: async (k) => void (current = k), dispose: () => undefined };
}

export interface Device {
  readonly runtime: Runtime;
  readonly factory: IDBFactory;
  readonly vaults: WebVaultDirectory;
  readonly errors: string[];
  /** Takes the device off the network (open connections drop) or back on. */
  setOnline(online: boolean): void;
}

/** One app instance with its own browser storage, talking to `relay`. Drive is unreachable. */
export function device(relay: MockRelay): Device {
  const factory = new IDBFactory();
  const vaults = new WebVaultDirectory(factory);
  const sockets = new Set<MockSocket>();
  const errors: string[] = [];
  let online = true;
  const runtime = createRuntime({
    vaults,
    sealer: localSealer(),
    auth: createAuthSession(fakeGoogle()),
    relayUrl: 'ws://relay.test/ws',
    createSocket: (url) => {
      const socket = new MockSocket(relay, url, online);
      sockets.add(socket);
      return socket;
    },
    driveFetch: () => Promise.reject(new TypeError('Google Drive is not part of these tests.')),
    onError: (message) => errors.push(message),
  });
  return {
    runtime,
    factory,
    vaults,
    errors,
    setOnline(next) {
      online = next;
      if (!next) for (const socket of sockets) socket.drop();
    },
  };
}

/** Polls `check` every 10 ms. Counts polls rather than reading the clock, which tests may move. */
export async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000): Promise<void> {
  for (let waited = 0; waited < timeoutMs; waited += 10) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** A user's two devices on one vault, both signed in and connected. */
export async function twoDevices(relay = new MockRelay()): Promise<{ relay: MockRelay; a: Device; b: Device; vaultId: VaultId }> {
  const a = device(relay);
  await a.runtime.init();
  if ((await a.runtime.createVault('Personal', PASSPHRASE)) !== null) throw new Error('vault not created');
  const vaultId = a.runtime.vaults()[0]?.id as VaultId;

  // The second device gets the vault's (non-secret) header, as it would from Google Drive,
  // and derives the same key from the same passphrase.
  const source = await new WebVaultDirectory(a.factory).open(vaultId);
  const b = device(relay);
  await b.vaults.create(vaultId, (await source.getVaultHeader()) as string, await source.getVaultName(), a.runtime.vaults()[0]?.createdAt);
  await b.runtime.init();
  if ((await b.runtime.unlock(vaultId, PASSPHRASE)) !== null) throw new Error('vault not unlocked on B');

  await a.runtime.signIn();
  await b.runtime.signIn();
  await until(
    () => a.runtime.syncStatus().connection === 'open' && b.runtime.syncStatus().connection === 'open',
    'both devices online',
  );
  return { relay, a, b, vaultId };
}

/** The text of a note as a device has it, opening its doc if needed. */
export async function textOf(d: Device, noteId: NoteId): Promise<string> {
  return (await d.runtime.openDoc(noteId)).getText(TEXT_FIELD).toString();
}
