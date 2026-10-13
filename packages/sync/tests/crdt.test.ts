import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Bytes, EpochMs, NoteId } from '@ankylock/core';
import { createKeySealer, type Sealer } from '@ankylock/crypto';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import {
  DocManager,
  OutboxQueue,
  REMOTE_ORIGIN,
  TEXT_FIELD,
  decodeFrame,
  watchDoc,
  type DeviceId,
  type PacketTransport,
  type SyncPacket,
} from '../src/index.js';

const NOTE = '3f8b2a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' as NoteId;

async function sharedSealer(): Promise<Sealer> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return createKeySealer(() => key);
}

const textOf = (doc: Y.Doc): string => doc.getText(TEXT_FIELD).toString();

describe('DocManager', () => {
  it('keeps one doc per note and returns its state on close', () => {
    const docs = new DocManager();
    const doc = docs.open(NOTE);
    expect(docs.open(NOTE)).toBe(doc);
    doc.getText(TEXT_FIELD).insert(0, 'hello');
    const state = docs.close(NOTE);
    expect(docs.get(NOTE)).toBeUndefined();
    expect(state).not.toBeNull();
    expect(textOf(docs.open(NOTE, state ?? undefined))).toBe('hello');
  });

  it('applies remote updates only to open notes, idempotently', () => {
    const source = new Y.Doc();
    source.getText(TEXT_FIELD).insert(0, 'once');
    const update = new Uint8Array(Y.encodeStateAsUpdate(source));

    const docs = new DocManager();
    expect(docs.applyRemote(NOTE, update)).toBe(false);
    docs.open(NOTE);
    expect(docs.applyRemote(NOTE, update)).toBe(true);
    expect(docs.applyRemote(NOTE, update)).toBe(true);
    expect(textOf(docs.get(NOTE) as Y.Doc)).toBe('once');
  });
});

describe('watchDoc (delta packer)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges a burst of keystrokes into one encrypted packet after the 150 ms window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sealer = await sharedSealer();
    const packets: SyncPacket[] = [];
    const doc = new Y.Doc();
    const watcher = watchDoc(NOTE, doc, {
      sealer,
      deviceId: 'device-a' as DeviceId,
      now: () => 1_776_100_000_000 as EpochMs,
      onPacket: async (p) => {
        packets.push(p);
      },
      onError: (e) => {
        throw e;
      },
    });

    const text = doc.getText(TEXT_FIELD);
    for (const ch of 'const secret = 42;') text.insert(text.length, ch);
    await vi.advanceTimersByTimeAsync(149);
    expect(packets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await watcher.flush();

    expect(packets).toHaveLength(1);
    const packet = packets[0] as SyncPacket;
    expect(packet).toMatchObject({ packetType: 'CRDT_DELTA', entityId: NOTE, senderDeviceId: 'device-a' });
    expect(new TextDecoder().decode(packet.payload)).not.toContain('secret');

    const replica = new Y.Doc();
    Y.applyUpdate(replica, await sealer.open(packet.payload));
    expect(textOf(replica)).toBe('const secret = 42;');
  });

  it('does not re-broadcast remote updates (echo suppression)', async () => {
    const packets: SyncPacket[] = [];
    const doc = new Y.Doc();
    const watcher = watchDoc(NOTE, doc, {
      sealer: await sharedSealer(),
      deviceId: 'device-a' as DeviceId,
      onPacket: async (p) => {
        packets.push(p);
      },
      onError: () => undefined,
    });
    const peer = new Y.Doc();
    peer.getText(TEXT_FIELD).insert(0, 'from peer');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), REMOTE_ORIGIN);
    await watcher.dispose();
    expect(packets).toHaveLength(0);
  });

  it('flushes pending edits on dispose instead of dropping them', async () => {
    const packets: SyncPacket[] = [];
    const doc = new Y.Doc();
    const watcher = watchDoc(NOTE, doc, {
      sealer: await sharedSealer(),
      deviceId: 'device-a' as DeviceId,
      onPacket: async (p) => {
        packets.push(p);
      },
      onError: () => undefined,
    });
    doc.getText(TEXT_FIELD).insert(0, 'last words');
    await watcher.dispose();
    expect(packets).toHaveLength(1);
    doc.getText(TEXT_FIELD).insert(0, 'after dispose ');
    await watcher.flush();
    expect(packets).toHaveLength(1);
  });

  it('reports sealing failures without throwing from the Yjs observer', async () => {
    const errors: unknown[] = [];
    const doc = new Y.Doc();
    const failing: Sealer = {
      seal: () => Promise.reject(new Error('vault locked')),
      open: () => Promise.reject(new Error('vault locked')),
    };
    const watcher = watchDoc(NOTE, doc, {
      sealer: failing,
      deviceId: 'device-a' as DeviceId,
      onPacket: async () => undefined,
      onError: (e) => errors.push(e),
    });
    doc.getText(TEXT_FIELD).insert(0, 'x');
    await watcher.flush();
    expect(errors).toHaveLength(1);
    expect(textOf(doc)).toBe('x');
  });
});

/** Relay stand-in: forwards each frame to every other connected device, byte for byte. */
class MockRelay {
  readonly #devices = new Set<Device>();

  join(device: Device): void {
    this.#devices.add(device);
  }

  forward(from: Device, frame: Bytes): void {
    for (const device of this.#devices) if (device !== from) device.receive(frame);
  }
}

class Device implements PacketTransport {
  online = false;
  readonly docs = new DocManager();
  readonly storage = new WebIndexedDbAdapter(new IDBFactory());
  readonly queue: OutboxQueue;
  readonly #received: Promise<void>[] = [];

  constructor(
    readonly id: DeviceId,
    readonly relay: MockRelay,
    readonly sealer: Sealer,
  ) {
    this.queue = new OutboxQueue(this.storage, this, id);
    relay.join(this);
  }

  send(frame: Bytes): boolean {
    if (!this.online) return false;
    this.relay.forward(this, frame);
    return true;
  }

  receive(frame: Bytes): void {
    const decoded = decodeFrame(frame);
    if (!decoded.ok || decoded.packet.senderDeviceId === this.id) return;
    const { entityId, payload } = decoded.packet;
    this.#received.push(
      this.sealer.open(payload).then((update) => {
        this.docs.applyRemote(entityId as NoteId, update);
      }),
    );
  }

  watch(noteId: NoteId): ReturnType<typeof watchDoc> {
    return watchDoc(noteId, this.docs.open(noteId), {
      sealer: this.sealer,
      deviceId: this.id,
      onPacket: (packet) => this.queue.submit(packet),
      onError: (e) => {
        throw e;
      },
    });
  }

  async settled(): Promise<void> {
    await Promise.all(this.#received);
  }
}

describe('cross-device sync (SPEC §6)', () => {
  it('replicates an unsaved scratchpad in real time', async () => {
    const relay = new MockRelay();
    const sealer = await sharedSealer();
    const a = new Device('desktop-a' as DeviceId, relay, sealer);
    const b = new Device('web-b' as DeviceId, relay, sealer);
    a.online = b.online = true;
    await a.queue.drain();
    b.docs.open(NOTE);

    const watcher = a.watch(NOTE);
    a.docs.get(NOTE)?.getText(TEXT_FIELD).insert(0, 'const secret = 42;');
    await watcher.flush();
    await b.settled();

    expect(textOf(b.docs.get(NOTE) as Y.Doc)).toBe('const secret = 42;');
    expect(await a.storage.listOutbox(10)).toEqual([]);
  });

  it('merges concurrent offline edits without data loss or LWW', async () => {
    const relay = new MockRelay();
    const sealer = await sharedSealer();
    const a = new Device('desktop-a' as DeviceId, relay, sealer);
    const b = new Device('web-b' as DeviceId, relay, sealer);
    const watchA = a.watch(NOTE);
    const watchB = b.watch(NOTE);

    // Both offline: edits persist to each device's encrypted outbox.
    a.docs.get(NOTE)?.getText(TEXT_FIELD).insert(0, 'Line A\n');
    b.docs.get(NOTE)?.getText(TEXT_FIELD).insert(0, 'Line B\n');
    await Promise.all([watchA.flush(), watchB.flush()]);
    const queuedA = await a.storage.listOutbox(10);
    expect(queuedA).toHaveLength(1);
    expect(new TextDecoder().decode(queuedA[0]?.encryptedPayload)).not.toContain('Line A');

    // Both reconnect and drain their outboxes through the relay.
    a.online = b.online = true;
    await Promise.all([a.queue.drain(), b.queue.drain()]);
    await Promise.all([a.settled(), b.settled()]);

    const textA = textOf(a.docs.get(NOTE) as Y.Doc);
    const textB = textOf(b.docs.get(NOTE) as Y.Doc);
    expect(textA).toBe(textB);
    expect(textA).toContain('Line A');
    expect(textA).toContain('Line B');
    expect(await a.storage.listOutbox(10)).toEqual([]);
    expect(await b.storage.listOutbox(10)).toEqual([]);
  });
});
