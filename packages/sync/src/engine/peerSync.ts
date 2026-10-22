import * as Y from 'yjs';
import type { EpochMs, Note, NoteId } from '@ankylock/core';
import { base64ToBytes, bytesToBase64, type Sealer } from '@ankylock/crypto';
import type { IStorageEngine, Tombstone } from '@ankylock/storage';
import type { DocManager } from '../crdt/docManager.js';
import { createHierarchyPacket } from '../hierarchy/hierarchySync.js';
import { loadNoteState } from '../persistence/notePersistence.js';
import { packetContext, type DeviceId, type SyncPacket } from '../protocol/frame.js';

/**
 * Sync handshake (SPEC §5.2). The relay keeps no history, so packets sent while a device was
 * offline never reach it. On every (re)connect a device sends a SYNC_REQUEST with the Yjs state
 * vector of each note it holds; every other online device answers with what the requester lacks.
 */
export type StateVectors = ReadonlyMap<NoteId, Uint8Array>;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Every note: live ones in every folder (and loose), plus trashed ones. */
async function allNotes(storage: IStorageEngine): Promise<Note[]> {
  const [live, trashedFolders, trashed] = await Promise.all([
    storage.listFolders(),
    storage.listTrashedFolders(),
    storage.listTrashedNotes(),
  ]);
  const perFolder = await Promise.all(
    [null, ...live.map((f) => f.id), ...trashedFolders.map((f) => f.id)].map((id) => storage.listNotes(id)),
  );
  return [...perFolder.flat(), ...trashed];
}

/**
 * State vectors of the notes on this device. Stored vectors are plaintext clock metadata, so
 * nothing is decrypted; open docs may be ahead of storage and use their live vector.
 */
export async function localStateVectors(storage: IStorageEngine, docs: DocManager): Promise<Map<NoteId, Uint8Array>> {
  const vectors = new Map<NoteId, Uint8Array>();
  for (const note of await allNotes(storage)) {
    const open = docs.get(note.id);
    if (open) vectors.set(note.id, Y.encodeStateVector(open));
    else {
      const content = await storage.getNoteContent(note.id);
      if (content) vectors.set(note.id, content.yjsStateVector);
    }
  }
  return vectors;
}

/** Whether `local` has updates `remote` lacks (some client is further ahead locally). */
export function isAhead(local: Uint8Array, remote: Uint8Array | undefined): boolean {
  if (!remote) return Y.decodeStateVector(local).size > 0;
  const theirs = Y.decodeStateVector(remote);
  for (const [client, clock] of Y.decodeStateVector(local)) {
    if (clock > (theirs.get(client) ?? 0)) return true;
  }
  return false;
}

/** What a device sends on connect: its note state vectors, and its purges for the others to apply. */
export interface SyncRequest {
  readonly stateVectors: StateVectors;
  readonly tombstones: readonly Tombstone[];
}

/**
 * A device's purges travel with its request: a purge made while it was offline or locking (its
 * TOMBSTONE packet never sent) still reaches the devices online when it next connects.
 */
export async function createSyncRequest(
  sealer: Sealer,
  deviceId: DeviceId,
  vectors: StateVectors,
  now: EpochMs,
  tombstones: readonly Tombstone[] = [],
): Promise<SyncPacket> {
  const body = Object.fromEntries([...vectors].map(([id, vector]) => [id, bytesToBase64(vector)]));
  return {
    packetType: 'SYNC_REQUEST',
    entityId: deviceId as unknown as NoteId,
    senderDeviceId: deviceId,
    timestampMs: now,
    payload: await sealer.seal(encoder.encode(JSON.stringify({ stateVectors: body, tombstones })), packetContext('SYNC_REQUEST', deviceId)),
  };
}

/** AES-GCM authenticated the payload, so this vault wrote it; only the shape needs checking. */
export function readSyncRequest(plaintext: Uint8Array): SyncRequest {
  const value: unknown = JSON.parse(decoder.decode(plaintext));
  if (typeof value !== 'object' || value === null) throw new Error('Sync request is malformed.');
  const { stateVectors: raw, tombstones } = value as { stateVectors?: unknown; tombstones?: unknown };
  const vectors = typeof raw === 'object' && raw !== null ? raw : {};
  return {
    stateVectors: new Map(
      Object.entries(vectors).flatMap(([id, vector]) =>
        typeof vector === 'string' ? [[id as NoteId, base64ToBytes(vector)] as const] : [],
      ),
    ),
    tombstones: Array.isArray(tombstones) ? (tombstones as Tombstone[]) : [],
  };
}

export interface AnswerDeps {
  readonly storage: IStorageEngine;
  readonly sealer: Sealer;
  readonly docs: DocManager;
  readonly deviceId: DeviceId;
  readonly now: () => EpochMs;
}

/**
 * What the requester lacks: a Yjs diff per note that is ahead here (only those are decrypted),
 * and all hierarchy records with this device's purges, merged on arrival by their clocks.
 */
export async function answerSyncRequest(deps: AnswerDeps, theirs: StateVectors): Promise<SyncPacket[]> {
  const { storage, sealer, docs, deviceId } = deps;
  const notes = await allNotes(storage);
  const packets: SyncPacket[] = [];
  for (const note of notes) {
    const open = docs.get(note.id);
    const vector = open ? Y.encodeStateVector(open) : (await storage.getNoteContent(note.id))?.yjsStateVector;
    if (!vector || !isAhead(vector, theirs.get(note.id))) continue;
    let diff: Uint8Array;
    if (open) diff = Y.encodeStateAsUpdate(open, theirs.get(note.id));
    else {
      const state = await loadNoteState({ storage, sealer }, note.id);
      if (!state) continue;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      diff = Y.encodeStateAsUpdate(doc, theirs.get(note.id));
      doc.destroy();
    }
    packets.push({
      packetType: 'CRDT_DELTA',
      entityId: note.id,
      senderDeviceId: deviceId,
      timestampMs: deps.now(),
      payload: await sealer.seal(new Uint8Array(diff), packetContext('CRDT_DELTA', note.id)),
    });
  }
  const [categories, live, trashedFolders, tombstones] = await Promise.all([
    storage.listCategories(),
    storage.listFolders(),
    storage.listTrashedFolders(),
    storage.listTombstones(),
  ]);
  const records = { categories, folders: [...live, ...trashedFolders], notes, tombstones };
  if (categories.length + records.folders.length + notes.length + tombstones.length > 0) {
    packets.unshift(await createHierarchyPacket(sealer, deviceId, records, deps.now()));
  }
  return packets;
}
