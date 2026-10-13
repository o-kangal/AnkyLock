import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { CategoryId, Ciphertext, EpochMs, FolderId, NoteId, SealedBytes } from '@ankylock/core';
import { createKeySealer, type Sealer } from '@ankylock/crypto';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import {
  DriveError,
  GoogleDriveClient,
  SNAPSHOT_FILE_NAME,
  VAULT_HEADER_FILE_NAME,
  createSnapshotScheduler,
  exportSnapshot,
  openSnapshot,
  type BackupStatus,
} from '../src/index.js';

const NOW = 1_776_100_000_000 as EpochMs;

async function sealer(): Promise<Sealer> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return createKeySealer(() => key);
}

describe('encrypted snapshot', () => {
  it('round-trips every record and hides structure behind one seal', async () => {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    await storage.createCategory('work-category' as CategoryId, 'Y2F0' as Ciphertext);
    await storage.createFolder({ id: 'inbox-folder' as FolderId, parentId: null, categoryId: null, nameCiphertext: 'Zg==' as Ciphertext });
    await storage.createNote('live-note' as NoteId);
    await storage.moveNote('live-note' as NoteId, 'inbox-folder' as FolderId, null);
    await storage.saveNoteContent({
      noteId: 'live-note' as NoteId,
      titleCiphertext: 'dA==' as Ciphertext,
      contentCiphertext: new Uint8Array([1, 2, 3]) as SealedBytes,
      yjsStateVector: new Uint8Array([4]),
      yjsUpdates: new Uint8Array([5, 6]) as SealedBytes,
      updatedAt: NOW,
    });
    await storage.createNote('trashed-note' as NoteId);
    await storage.trashNote('trashed-note' as NoteId);
    await storage.setTrashRetentionDays(14);

    const s = await sealer();
    const sealed = await exportSnapshot(storage, s, NOW);
    const raw = new TextDecoder('latin1').decode(sealed);
    for (const marker of ['work-category', 'inbox-folder', 'live-note', 'retentionDays']) expect(raw).not.toContain(marker);

    const snapshot = await openSnapshot(s, sealed);
    expect(snapshot).toMatchObject({ version: 1, createdAt: NOW, retentionDays: 14 });
    expect(snapshot.categories.map((c) => c.id)).toEqual(['work-category']);
    expect(snapshot.folders.map((f) => f.id)).toEqual(['inbox-folder']);
    expect(snapshot.notes.map((n) => n.id).sort()).toEqual(['live-note', 'trashed-note']);
    expect(snapshot.contents[0]?.contentCiphertext).toEqual(new Uint8Array([1, 2, 3]));
    expect(snapshot.contents[0]?.yjsUpdates).toEqual(new Uint8Array([5, 6]));
  });

  it('cannot be opened with another vault key', async () => {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    const sealed = await exportSnapshot(storage, await sealer(), NOW);
    await expect(openSnapshot(await sealer(), sealed)).rejects.toMatchObject({ code: 'ERR_DECRYPT_FAILED' });
  });
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
}

function fakeDrive(responses: (call: Call) => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
    };
    calls.push(call);
    return responses(call);
  };
  return { fetch: fakeFetch, calls };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const client = (f: typeof fetch): GoogleDriveClient => new GoogleDriveClient({ getAccessToken: async () => 'token-123', fetch: f });

describe('GoogleDriveClient', () => {
  it('creates new files in appDataFolder with a multipart upload', async () => {
    const drive = fakeDrive((call) => (call.method === 'GET' ? json({ files: [] }) : json({ id: 'new' })));
    await client(drive.fetch).upload(SNAPSHOT_FILE_NAME, new Uint8Array([9, 9]), 'application/octet-stream');

    const [find, create] = drive.calls;
    expect(find?.url).toContain('spaces=appDataFolder');
    expect(find?.headers.get('Authorization')).toBe('Bearer token-123');
    expect(create).toMatchObject({ method: 'POST' });
    expect(create?.url).toContain('/upload/drive/v3/files?uploadType=multipart');
    const body = await (create?.body as Blob).text();
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain(`"name":"${SNAPSHOT_FILE_NAME}"`);
  });

  it('replaces the content of an existing file', async () => {
    const drive = fakeDrive((call) => (call.method === 'GET' ? json({ files: [{ id: 'abc' }] }) : json({ id: 'abc' })));
    await client(drive.fetch).upload(SNAPSHOT_FILE_NAME, new Uint8Array([1]), 'application/octet-stream');
    expect(drive.calls[1]).toMatchObject({ method: 'PATCH' });
    expect(drive.calls[1]?.url).toContain('/upload/drive/v3/files/abc?uploadType=media');
  });

  it('downloads file content', async () => {
    const drive = fakeDrive((call) =>
      call.url.includes('alt=media') ? new Response(new Uint8Array([7, 8])) : json({ files: [{ id: 'abc' }] }),
    );
    expect(await client(drive.fetch).download(SNAPSHOT_FILE_NAME)).toEqual(new Uint8Array([7, 8]));
    const missing = fakeDrive(() => json({ files: [] }));
    expect(await client(missing.fetch).download(SNAPSHOT_FILE_NAME)).toBeNull();
  });

  it.each([
    [json({}, 401), 'auth'],
    [json({ error: { errors: [{ reason: 'storageQuotaExceeded' }] } }, 403), 'quota'],
    [json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, 403), 'auth'],
    [new Response('oops', { status: 500 }), 'http'],
  ] as const)('maps failures to error kinds (%#)', async (response, kind) => {
    const drive = fakeDrive(() => response.clone());
    await expect(client(drive.fetch).findFileId('x')).rejects.toMatchObject({ name: 'DriveError', kind });
  });

  it('reports network failures', async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(client(offline).findFileId('x')).rejects.toMatchObject({ kind: 'network', status: null });
  });
});

describe('createSnapshotScheduler', () => {
  function scheduler(upload: (name: string) => Promise<void>, createSnapshot = async () => new Uint8Array([1]) as SealedBytes) {
    let t = NOW as number;
    const statuses: BackupStatus[] = [];
    const uploads: string[] = [];
    const s = createSnapshotScheduler({
      drive: {
        upload: async (name) => {
          uploads.push(name);
          await upload(name);
        },
      },
      createSnapshot,
      vaultHeader: () => '{"version":1}',
      onStatus: (status) => statuses.push(status),
      now: () => t as EpochMs,
      idleMinGapMs: 1_000,
    });
    return { s, statuses, uploads, advance: (ms: number) => (t += ms) };
  }

  it('uploads the vault header and the snapshot and reports success', async () => {
    const { s, statuses, uploads } = scheduler(async () => undefined);
    expect(await s.runNow()).toEqual({ kind: 'ok', at: NOW });
    expect(uploads).toEqual([VAULT_HEADER_FILE_NAME, SNAPSHOT_FILE_NAME]);
    expect(statuses).toEqual([{ kind: 'ok', at: NOW }]);
  });

  it('reports Drive failures without throwing (quota, auth)', async () => {
    const { s, statuses } = scheduler(async () => {
      throw new DriveError('quota', 403, 'full');
    });
    await expect(s.runNow()).resolves.toEqual({ kind: 'error', reason: 'quota', at: NOW });
    expect(statuses).toHaveLength(1);
  });

  it('reports a failed local export as a snapshot error', async () => {
    const { s } = scheduler(async () => undefined, () => Promise.reject(new Error('vault locked')));
    expect(await s.runNow()).toMatchObject({ kind: 'error', reason: 'snapshot' });
  });

  it('only backs up on idle when the last success is old enough', async () => {
    const { s, uploads, advance } = scheduler(async () => undefined);
    await s.runNow();
    s.notifyIdle();
    await Promise.resolve();
    expect(uploads).toHaveLength(2);
    advance(1_000);
    s.notifyIdle();
    await s.runNow();
    expect(uploads).toHaveLength(4);
  });
});
