import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import type { Bytes, CategoryId, Ciphertext, EpochMs, FolderId, NoteId, SealedBytes, VaultId } from '@ankylock/core';
import { createKeySealer, type Sealer } from '@ankylock/crypto';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import {
  DriveError,
  GoogleDriveClient,
  TEXT_FIELD,
  createSnapshotScheduler,
  downloadSnapshots,
  exportSnapshot,
  listRemoteVaults,
  loadNoteState,
  mergeSnapshots,
  openSnapshot,
  saveNoteState,
  deleteVaultFromDrive,
  removeLegacyDriveFiles,
  syncHeaderFile,
  vaultHeaderFileName,
  vaultSnapshotFileName,
  type BackupStatus,
  type DriveFile,
  type VaultHeaderFile,
} from '../src/index.js';
import * as Y from 'yjs';

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
    await client(drive.fetch).upload('file.bin', new Uint8Array([9, 9]), 'application/octet-stream');

    const [find, create] = drive.calls;
    expect(find?.url).toContain('spaces=appDataFolder');
    expect(find?.headers.get('Authorization')).toBe('Bearer token-123');
    expect(create).toMatchObject({ method: 'POST' });
    expect(create?.url).toContain('/upload/drive/v3/files?uploadType=multipart');
    const body = await (create?.body as Blob).text();
    expect(body).toContain('"parents":["appDataFolder"]');
    expect(body).toContain('"name":"file.bin"');
  });

  it('replaces the content of an existing file', async () => {
    const drive = fakeDrive((call) => (call.method === 'GET' ? json({ files: [{ id: 'abc' }] }) : json({ id: 'abc' })));
    await client(drive.fetch).upload('file.bin', new Uint8Array([1]), 'application/octet-stream');
    expect(drive.calls[1]).toMatchObject({ method: 'PATCH' });
    expect(drive.calls[1]?.url).toContain('/upload/drive/v3/files/abc?uploadType=media');
  });

  it('lists files by name prefix across pages', async () => {
    const drive = fakeDrive((call) =>
      call.url.includes('pageToken=p2')
        ? json({ files: [{ id: '2', name: 'vault-b', modifiedTime: '2026-10-14T10:00:00.000Z' }] })
        : json({
            nextPageToken: 'p2',
            files: [
              { id: '1', name: 'vault-a', modifiedTime: '2026-10-14T09:00:00.000Z' },
              { id: '9', name: 'my-vault-x', modifiedTime: '2026-10-14T09:00:00.000Z' },
            ],
          }),
    );
    const files = await client(drive.fetch).listFiles('vault-');
    expect(files.map((f) => f.id)).toEqual(['1', '2']);
    expect(files[1]?.modifiedTime).toBe(Date.parse('2026-10-14T10:00:00.000Z'));
    expect(new URL(drive.calls[0]?.url ?? '').searchParams.get('q')).toBe("name contains 'vault-' and trashed = false");
  });

  it('downloads file content', async () => {
    const drive = fakeDrive((call) =>
      call.url.includes('alt=media') ? new Response(new Uint8Array([7, 8])) : json({ files: [{ id: 'abc' }] }),
    );
    expect(await client(drive.fetch).download('file.bin')).toEqual(new Uint8Array([7, 8]));
    const missing = fakeDrive(() => json({ files: [] }));
    expect(await client(missing.fetch).download('file.bin')).toBeNull();
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

/** In-memory appDataFolder: the parts of GoogleDriveClient the catalog and scheduler use. */
class MemoryDrive {
  readonly files = new Map<string, { id: string; data: Bytes; modifiedTime: EpochMs }>();
  failWith: DriveError | null = null;
  #next = 0;
  constructor(readonly now: () => EpochMs = () => NOW) {}

  #check(): void {
    if (this.failWith) throw this.failWith;
  }

  async upload(name: string, data: Bytes): Promise<void> {
    this.#check();
    const existing = this.files.get(name);
    this.files.set(name, { id: existing?.id ?? `f${++this.#next}`, data, modifiedTime: this.now() });
  }

  async create(name: string, data: Bytes): Promise<void> {
    this.#check();
    if (this.files.has(name)) throw new Error('test drive keeps one file per name');
    this.files.set(name, { id: `f${++this.#next}`, data, modifiedTime: this.now() });
  }

  async download(name: string): Promise<Bytes | null> {
    this.#check();
    return this.files.get(name)?.data ?? null;
  }

  async listFiles(prefix: string): Promise<DriveFile[]> {
    return [...this.files.entries()]
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, f]) => ({ id: f.id, name, modifiedTime: f.modifiedTime }));
  }

  async deleteFile(id: string): Promise<void> {
    for (const [name, f] of this.files) if (f.id === id) this.files.delete(name);
  }

  async downloadFile(id: string): Promise<Bytes> {
    const file = [...this.files.values()].find((f) => f.id === id);
    if (!file) throw new DriveError('http', 404, 'missing');
    return file.data;
  }
}

const VAULT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as VaultId;
const DEVICE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddd0a';
const DEVICE_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddd0b';
const headerFile = (header = '{"kdf":"a"}'): VaultHeaderFile => ({
  vaultId: VAULT,
  createdAt: 5 as EpochMs,
  header,
  nameCiphertext: 'bmFtZQ==' as Ciphertext,
  nameUpdatedAt: 0 as EpochMs,
});

describe('createSnapshotScheduler', () => {
  function scheduler(
    drive = new MemoryDrive(),
    createSnapshot = async () => new Uint8Array([1]) as SealedBytes,
    prepare: () => Promise<'conflict' | 'deleted' | null> = async () => null,
  ) {
    let t = NOW as number;
    const statuses: BackupStatus[] = [];
    const s = createSnapshotScheduler({
      drive,
      createSnapshot,
      snapshotFile: vaultSnapshotFileName(VAULT, DEVICE_A),
      prepare,
      onStatus: (status) => statuses.push(status),
      now: () => t as EpochMs,
      idleMinGapMs: 1_000,
    });
    return { s, drive, statuses, advance: (ms: number) => (t += ms) };
  }

  it("uploads this device's own snapshot after preparing the header", async () => {
    const { s, drive, statuses } = scheduler();
    expect(await s.runNow()).toEqual({ kind: 'ok', at: NOW });
    expect([...drive.files.keys()]).toEqual([vaultSnapshotFileName(VAULT, DEVICE_A)]);
    expect(statuses).toEqual([{ kind: 'running' }, { kind: 'ok', at: NOW }]);
  });

  it('uploads nothing while the header is in conflict or the vault was deleted', async () => {
    for (const reason of ['conflict', 'deleted'] as const) {
      const { s, drive } = scheduler(new MemoryDrive(), undefined, async () => reason);
      expect(await s.runNow()).toMatchObject({ kind: 'error', reason });
      expect(drive.files.size).toBe(0);
    }
  });

  it('reports Drive failures without throwing (quota, auth)', async () => {
    const drive = new MemoryDrive();
    drive.failWith = new DriveError('quota', 403, 'full');
    const { s, statuses } = scheduler(drive);
    await expect(s.runNow()).resolves.toEqual({ kind: 'error', reason: 'quota', at: NOW });
    expect(statuses).toEqual([{ kind: 'running' }, { kind: 'error', reason: 'quota', at: NOW }]);
  });

  it('reports a failed local export as a snapshot error', async () => {
    const { s } = scheduler(new MemoryDrive(), () => Promise.reject(new Error('vault locked')));
    expect(await s.runNow()).toMatchObject({ kind: 'error', reason: 'snapshot' });
  });

  it('only backs up on idle when the last success is old enough', async () => {
    let uploads = 0;
    const drive = new MemoryDrive();
    const upload = drive.upload.bind(drive);
    drive.upload = async (name, data) => {
      uploads++;
      await upload(name, data);
    };
    const { s, advance } = scheduler(drive);
    await s.runNow();
    s.notifyIdle();
    await Promise.resolve();
    expect(uploads).toBe(1);
    advance(1_000);
    s.notifyIdle();
    await s.runNow();
    expect(uploads).toBe(2);
  });
});

describe('syncHeaderFile', () => {
  const header = (overrides: Partial<VaultHeaderFile> = {}): VaultHeaderFile => ({ ...headerFile(), nameUpdatedAt: 0 as EpochMs, ...overrides });
  const stored = (drive: MemoryDrive) => JSON.parse(new TextDecoder().decode(drive.files.get(vaultHeaderFileName(VAULT))?.data)) as VaultHeaderFile;

  it('creates the header once, and never replaces a different key header', async () => {
    const drive = new MemoryDrive();
    expect(await syncHeaderFile(drive, header(), false)).toEqual({ kind: 'ready', name: null });
    expect(await syncHeaderFile(drive, header(), true)).toEqual({ kind: 'ready', name: null });
    expect(await syncHeaderFile(drive, header({ header: '{"kdf":"other"}' }), true)).toEqual({ kind: 'conflict' });
    expect(stored(drive).header).toBe('{"kdf":"a"}');
  });

  it('moves the newer name either way', async () => {
    const drive = new MemoryDrive();
    await syncHeaderFile(drive, header(), false);
    await syncHeaderFile(drive, header({ nameCiphertext: 'bmV3' as Ciphertext, nameUpdatedAt: 10 as EpochMs }), true);
    expect(stored(drive)).toMatchObject({ nameCiphertext: 'bmV3', nameUpdatedAt: 10 });
    // Another device with an older name adopts the newer one instead of overwriting it.
    expect(await syncHeaderFile(drive, header({ nameUpdatedAt: 5 as EpochMs }), true)).toEqual({
      kind: 'ready',
      name: { ciphertext: 'bmV3', updatedAt: 10 },
    });
  });

  it('reports a vault deleted elsewhere instead of uploading it again', async () => {
    const drive = new MemoryDrive();
    expect(await syncHeaderFile(drive, header(), true)).toEqual({ kind: 'deleted' });
    expect(drive.files.size).toBe(0);
  });
});

describe('Drive cleanup', () => {
  it("deletes a vault's header and every snapshot, and the pre-vault-id files", async () => {
    const drive = new MemoryDrive();
    await syncHeaderFile(drive, { ...headerFile(), nameUpdatedAt: 0 as EpochMs }, false);
    for (const name of [vaultSnapshotFileName(VAULT, DEVICE_A), vaultSnapshotFileName(VAULT, DEVICE_B), 'ankylock-snapshot.v1.bin', 'ankylock-vault-header.v1.json', 'vault-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.header.json']) {
      await drive.upload(name, new Uint8Array([1]) as Bytes);
    }
    await deleteVaultFromDrive(drive, VAULT);
    expect(await removeLegacyDriveFiles(drive)).toBe(2);
    expect([...drive.files.keys()]).toEqual(['vault-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.header.json']);
  });
});

describe('vault catalog', () => {
  async function deviceBackup(s: Sealer, drive: MemoryDrive, deviceId: string, edit: (storage: WebIndexedDbAdapter) => Promise<void>) {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    await edit(storage);
    const scheduler = createSnapshotScheduler({
      drive,
      createSnapshot: () => exportSnapshot(storage, s, NOW),
      snapshotFile: vaultSnapshotFileName(VAULT, deviceId),
      prepare: async () => ((await syncHeaderFile(drive, headerFile(), false)).kind === 'ready' ? null : 'conflict'),
      onStatus: () => undefined,
    });
    expect(await scheduler.runNow()).toMatchObject({ kind: 'ok' });
  }

  async function writeNote(s: Sealer, storage: WebIndexedDbAdapter, id: NoteId, base: Uint8Array | null, text: string): Promise<Uint8Array> {
    if ((await storage.getNote(id)) === null) await storage.createNote(id);
    const doc = new Y.Doc();
    if (base) Y.applyUpdate(doc, base);
    doc.getText(TEXT_FIELD).insert(doc.getText(TEXT_FIELD).length, text);
    await saveNoteState({ storage, sealer: s }, id, doc, 'title');
    return Y.encodeStateAsUpdate(doc);
  }

  it('lists vaults with their snapshots and merges every device without losing text', async () => {
    const s = await sealer();
    const drive = new MemoryDrive();
    const NOTE = 'shared-note' as NoteId;
    let base: Uint8Array | null = null;
    await deviceBackup(s, drive, DEVICE_A, async (storage) => {
      base = await writeNote(s, storage, NOTE, null, 'from A');
      await storage.createNote('only-a' as NoteId);
    });
    await deviceBackup(s, drive, DEVICE_B, async (storage) => {
      await writeNote(s, storage, NOTE, base, ' and B');
      await storage.createFolder({ id: 'b-folder' as FolderId, parentId: null, categoryId: null, nameCiphertext: 'Zg==' as Ciphertext });
    });
    await drive.upload('vault-garbage.header.json', new Uint8Array([1]));

    const [vault, ...others] = await listRemoteVaults(drive);
    expect(others).toEqual([]);
    expect(vault).toMatchObject({ vaultId: VAULT, createdAt: 5, header: '{"kdf":"a"}', lastBackupAt: NOW });
    expect(vault?.snapshots).toHaveLength(2);

    const { snapshots, unreadable } = await downloadSnapshots(drive, s, vault!);
    expect(unreadable).toBe(0);
    const merged = await mergeSnapshots(s, snapshots);
    expect(merged.notes.map((n) => n.id).sort()).toEqual(['only-a', 'shared-note']);
    expect(merged.folders.map((f) => f.id)).toEqual(['b-folder']);

    const restored = new WebIndexedDbAdapter(new IDBFactory());
    await restored.importVault(merged);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await loadNoteState({ storage: restored, sealer: s }, NOTE))!);
    expect(doc.getText(TEXT_FIELD).toString()).toBe('from A and B');
  });

  it('skips snapshots another key sealed', async () => {
    const drive = new MemoryDrive();
    await deviceBackup(await sealer(), drive, DEVICE_A, async () => undefined);
    const [vault] = await listRemoteVaults(drive);
    expect(await downloadSnapshots(drive, await sealer(), vault!)).toEqual({ snapshots: [], unreadable: 1 });
  });
});
