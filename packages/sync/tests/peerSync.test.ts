import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { EpochMs, NoteId } from '@ankylock/core';
import { createKeySealer, type Sealer } from '@ankylock/crypto';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import {
  DocManager,
  TEXT_FIELD,
  answerSyncRequest,
  createSyncRequest,
  isAhead,
  localStateVectors,
  readHierarchyPayload,
  readSyncRequest,
  saveNoteState,
  type DeviceId,
  packetContext,
} from '../src/index.js';

const now = (): EpochMs => 1_776_100_000_000 as EpochMs;

/** A sealer that counts how many payloads it decrypted. */
async function countingSealer(): Promise<Sealer & { opened: number }> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const inner = createKeySealer(() => key);
  const sealer = {
    opened: 0,
    seal: inner.seal,
    open: (data: Parameters<Sealer['open']>[0], context?: Parameters<Sealer['open']>[1]) => {
      sealer.opened++;
      return inner.open(data, context);
    },
  };
  return sealer;
}

async function write(s: Sealer, storage: WebIndexedDbAdapter, id: NoteId, doc: Y.Doc, text: string): Promise<void> {
  if ((await storage.getNote(id)) === null) await storage.createNote(id);
  doc.getText(TEXT_FIELD).insert(doc.getText(TEXT_FIELD).length, text);
  await saveNoteState({ storage, sealer: s }, id, doc, null);
}

describe('isAhead', () => {
  it('compares clocks per client', () => {
    const a = new Y.Doc();
    a.getText(TEXT_FIELD).insert(0, 'x');
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(isAhead(Y.encodeStateVector(a), Y.encodeStateVector(b))).toBe(false);
    a.getText(TEXT_FIELD).insert(1, 'y');
    expect(isAhead(Y.encodeStateVector(a), Y.encodeStateVector(b))).toBe(true);
    expect(isAhead(Y.encodeStateVector(b), Y.encodeStateVector(a))).toBe(false);
    expect(isAhead(Y.encodeStateVector(a), undefined)).toBe(true);
    expect(isAhead(Y.encodeStateVector(new Y.Doc()), undefined)).toBe(false);
  });
});

describe('sync handshake', () => {
  it('requests with plaintext state vectors and answers only with what the requester lacks', async () => {
    const s = await countingSealer();
    const here = new WebIndexedDbAdapter(new IDBFactory());
    const same = new Y.Doc();
    const ahead = new Y.Doc();
    const onlyHere = new Y.Doc();
    await write(s, here, 'same' as NoteId, same, 'both have this');
    await write(s, here, 'ahead' as NoteId, ahead, 'old');
    const theirAhead = new Y.Doc();
    Y.applyUpdate(theirAhead, Y.encodeStateAsUpdate(ahead));
    await write(s, here, 'ahead' as NoteId, ahead, ' + new');
    await write(s, here, 'onlyHere' as NoteId, onlyHere, 'they never saw this');
    await here.trashNote('onlyHere' as NoteId);

    const theirs = new Map([
      ['same' as NoteId, Y.encodeStateVector(same)],
      ['ahead' as NoteId, Y.encodeStateVector(theirAhead)],
    ]);
    const request = await createSyncRequest(s, 'them' as DeviceId, theirs, now());
    const received = readSyncRequest(await s.open(request.payload, packetContext('SYNC_REQUEST', request.entityId))).stateVectors;
    expect([...received.keys()].sort()).toEqual(['ahead', 'same']);

    s.opened = 0;
    const packets = await answerSyncRequest({ storage: here, sealer: s, docs: new DocManager(), deviceId: 'me' as DeviceId, now }, received);
    // Only the two notes that are ahead were decrypted to build diffs.
    expect(s.opened).toBe(2);
    expect(packets.map((p) => [p.packetType, p.entityId])).toEqual([
      ['HIERARCHY_MUTATION', expect.any(String)],
      ['CRDT_DELTA', 'ahead'],
      ['CRDT_DELTA', 'onlyHere'],
    ]);
    const diff = await s.open(packets[1]!.payload, packetContext('CRDT_DELTA', packets[1]!.entityId));
    Y.applyUpdate(theirAhead, diff);
    expect(theirAhead.getText(TEXT_FIELD).toString()).toBe('old + new');
    const records = readHierarchyPayload(await s.open(packets[0]!.payload, packetContext('HIERARCHY_MUTATION', packets[0]!.entityId)));
    expect(records.notes?.map((n) => n.id).sort()).toEqual(['ahead', 'onlyHere', 'same']);
  });

  it('builds its own request from storage and open docs without decrypting', async () => {
    const s = await countingSealer();
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    await write(s, storage, 'stored' as NoteId, new Y.Doc(), 'saved');
    const docs = new DocManager();
    await storage.createNote('open' as NoteId);
    docs.open('open' as NoteId).getText(TEXT_FIELD).insert(0, 'unsaved');
    s.opened = 0;
    const vectors = await localStateVectors(storage, docs);
    expect([...vectors.keys()].sort()).toEqual(['open', 'stored']);
    expect(s.opened).toBe(0);
  });
});
