import type { Category, EpochMs, Folder, Note, NoteContent, SealedBytes } from '@ankylock/core';
import { base64ToBytes, bytesToBase64, type Sealer } from '@ankylock/crypto';
import type { IStorageEngine } from '@ankylock/storage';

export const SNAPSHOT_FILE_NAME = 'ankylock-snapshot.v1.bin';
export const VAULT_HEADER_FILE_NAME = 'ankylock-vault-header.v1.json';
const SNAPSHOT_VERSION = 1;

/** Decoded snapshot. Names, titles and bodies inside are still individually encrypted. */
export interface Snapshot {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly createdAt: EpochMs;
  readonly retentionDays: number;
  readonly categories: Category[];
  readonly folders: Folder[];
  readonly notes: Note[];
  readonly contents: NoteContent[];
}

type WireContent = Omit<NoteContent, 'contentCiphertext' | 'yjsStateVector' | 'yjsUpdates'> & {
  readonly contentCiphertext: string;
  readonly yjsStateVector: string;
  readonly yjsUpdates: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Exports everything storage holds into one JSON document, then seals the whole document with
 * the MEK. Fields that were already ciphertext stay ciphertext, and the outer seal also hides
 * structure (counts, ids, timestamps) from Google Drive. The format is the same on web and desktop.
 */
export async function exportSnapshot(storage: IStorageEngine, sealer: Sealer, now: EpochMs): Promise<SealedBytes> {
  const [categories, folders, trashed, retentionDays] = await Promise.all([
    storage.listCategories(),
    storage.listFolders(),
    storage.listTrashedNotes(),
    storage.getTrashRetentionDays(),
  ]);
  const live = await Promise.all([null, ...folders.map((f) => f.id)].map((id) => storage.listNotes(id)));
  const notes = [...live.flat(), ...trashed];
  const contents = (await Promise.all(notes.map((n) => storage.getNoteContent(n.id)))).flatMap((c) =>
    c === null
      ? []
      : [
          {
            ...c,
            contentCiphertext: bytesToBase64(c.contentCiphertext),
            yjsStateVector: bytesToBase64(c.yjsStateVector),
            yjsUpdates: bytesToBase64(c.yjsUpdates),
          } satisfies WireContent,
        ],
  );
  const document = { version: SNAPSHOT_VERSION, createdAt: now, retentionDays, categories, folders, notes, contents };
  return sealer.seal(encoder.encode(JSON.stringify(document)));
}

/**
 * Opens a snapshot sealed by `exportSnapshot`. AES-GCM authenticates the bytes, so a successful
 * open proves this vault wrote them; only the version needs checking before trusting the shape.
 */
export async function openSnapshot(sealer: Sealer, sealed: SealedBytes): Promise<Snapshot> {
  const parsed: unknown = JSON.parse(decoder.decode(await sealer.open(sealed)));
  if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== SNAPSHOT_VERSION) {
    throw new Error('Unsupported snapshot version.');
  }
  const raw = parsed as Omit<Snapshot, 'contents'> & { contents: WireContent[] };
  return {
    ...raw,
    contents: raw.contents.map((c) => ({
      ...c,
      contentCiphertext: base64ToBytes(c.contentCiphertext) as SealedBytes,
      yjsStateVector: base64ToBytes(c.yjsStateVector),
      yjsUpdates: base64ToBytes(c.yjsUpdates) as SealedBytes,
    })),
  };
}
