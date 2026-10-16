import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bytes, EpochMs, NoteId, SealedBytes } from '@ankylock/core';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import {
  BlindWebSocketClient,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  OutboxQueue,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeFrame,
  type DeviceId,
  type PacketTransport,
  type SocketLike,
  type SyncPacket,
} from '../src/index.js';

const sealed = (...values: number[]): SealedBytes => new Uint8Array([...new Array<number>(28).fill(7), ...values]) as SealedBytes;

const packet = (entityId: string, marker: number): SyncPacket => ({
  packetType: 'CRDT_DELTA',
  entityId: entityId as NoteId,
  senderDeviceId: 'device-a' as DeviceId,
  timestampMs: 1_776_100_000_000 as EpochMs,
  payload: sealed(marker),
});

describe('frame encoding (SPEC §5.2)', () => {
  it('uses the snake_case envelope with a base64 payload', () => {
    const frame = JSON.parse(new TextDecoder().decode(encodeFrame(packet('n1', 1)))) as Record<string, unknown>;
    expect(Object.keys(frame).sort()).toEqual([
      'encrypted_envelope',
      'entity_id',
      'packet_type',
      'protocol_version',
      'sender_device_id',
      'timestamp_ms',
    ]);
    expect(frame['protocol_version']).toBe(PROTOCOL_VERSION);
    expect(typeof frame['encrypted_envelope']).toBe('string');
  });

  it('round-trips', () => {
    const original = packet('n1', 9);
    expect(decodeFrame(encodeFrame(original))).toEqual({ ok: true, packet: original });
  });

  it('rejects unknown versions and malformed frames without throwing', () => {
    const encode = (o: unknown): Bytes => new TextEncoder().encode(JSON.stringify(o));
    const valid = JSON.parse(new TextDecoder().decode(encodeFrame(packet('n1', 1)))) as Record<string, unknown>;
    expect(decodeFrame(encode({ ...valid, protocol_version: 2 })).ok).toBe(false);
    expect(decodeFrame(encode({ ...valid, packet_type: 'CHAT' })).ok).toBe(false);
    expect(decodeFrame(encode({ ...valid, encrypted_envelope: 'AAAA' })).ok).toBe(false);
    expect(decodeFrame(encode({ ...valid, encrypted_envelope: '%%%' })).ok).toBe(false);
    expect(decodeFrame(new Uint8Array([0xff, 0xfe])).ok).toBe(false);
    expect(decodeFrame(encode([1, 2])).ok).toBe(false);
  });
});

describe('OutboxQueue', () => {
  class FakeTransport implements PacketTransport {
    online = false;
    failAfter = Infinity;
    readonly sent: SyncPacket[] = [];

    send(frame: Bytes): boolean {
      if (!this.online || this.sent.length >= this.failAfter) return false;
      const decoded = decodeFrame(frame);
      if (decoded.ok) this.sent.push(decoded.packet);
      return true;
    }
  }

  let storage: WebIndexedDbAdapter;
  let transport: FakeTransport;
  let queue: OutboxQueue;

  beforeEach(() => {
    storage = new WebIndexedDbAdapter(new IDBFactory());
    transport = new FakeTransport();
    queue = new OutboxQueue(storage, transport, 'device-a' as DeviceId);
  });

  const markers = (packets: SyncPacket[]): number[] => packets.map((p) => p.payload[28] ?? -1);

  it('queues encrypted payloads while offline and drains them in order', async () => {
    await queue.submit(packet('n1', 1));
    await queue.submit(packet('n1', 2));
    expect(await storage.listOutbox(10)).toHaveLength(2);

    transport.online = true;
    await queue.submit(packet('n1', 3)); // backlog exists: must not overtake older packets
    await queue.drain();
    expect(markers(transport.sent)).toEqual([1, 2, 3]);
    expect(await storage.listOutbox(10)).toEqual([]);

    await queue.submit(packet('n1', 4)); // backlog cleared: sent directly
    expect(markers(transport.sent)).toEqual([1, 2, 3, 4]);
    expect(await storage.listOutbox(10)).toEqual([]);
  });

  it('keeps unsent rows when the connection drops mid-drain', async () => {
    for (const m of [1, 2, 3]) await queue.submit(packet('n1', m));
    transport.online = true;
    transport.failAfter = 1;
    await queue.drain();
    expect(markers(transport.sent)).toEqual([1]);
    expect(await storage.listOutbox(10)).toHaveLength(2);

    transport.failAfter = Infinity;
    await queue.drain();
    expect(markers(transport.sent)).toEqual([1, 2, 3]);
  });

  it('sends packets queued while a drain is running instead of stranding them', async () => {
    transport.online = true;
    const draining = queue.drain();
    const submitting = queue.submit(packet('n1', 7));
    await Promise.all([draining, submitting]);
    expect(markers(transport.sent)).toEqual([7]);
    expect(await storage.listOutbox(10)).toEqual([]);
  });

  it('delivers a packet submitted while the first drain after connecting runs (regression)', async () => {
    // Startup: the backlog is unknown, so submits queue; the drain may see the outbox before the
    // row is written. Slow down that write to force the order.
    const enqueue = storage.enqueueOutbox.bind(storage);
    let release!: () => void;
    const written = new Promise<void>((resolve) => (release = resolve));
    storage.enqueueOutbox = async (entry) => {
      await written;
      return enqueue(entry);
    };
    transport.online = true;
    const submitting = queue.submit(packet('n1', 9));
    await queue.drain();
    release();
    await submitting;
    for (let i = 0; i < 50 && transport.sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(markers(transport.sent)).toEqual([9]);
    expect(await storage.listOutbox(10)).toEqual([]);
  });

  it('rebuilds packets from rows with this device as sender', async () => {
    await queue.submit(packet('n1', 5));
    transport.online = true;
    await queue.drain();
    expect(transport.sent[0]).toMatchObject({ packetType: 'CRDT_DELTA', entityId: 'n1', senderDeviceId: 'device-a' });
  });

  it('queues and replays every packet type with its type intact', async () => {
    await queue.submit({ ...packet('f1', 1), packetType: 'HIERARCHY_MUTATION' });
    await queue.submit({ ...packet('n1', 2), packetType: 'TOMBSTONE' });
    transport.online = true;
    await queue.drain();
    expect(transport.sent.map((p) => [p.entityId, p.packetType])).toEqual([
      ['f1', 'HIERARCHY_MUTATION'],
      ['n1', 'TOMBSTONE'],
    ]);
  });
});

describe('BlindWebSocketClient', () => {
  class FakeSocket implements SocketLike {
    static instances: FakeSocket[] = [];
    binaryType: BinaryType = 'blob';
    readyState = 0;
    readonly sent: (Bytes | string)[] = [];
    closed = false;
    onopen: ((event: Event) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(
      readonly url: string,
      readonly protocols: string[],
    ) {
      FakeSocket.instances.push(this);
    }

    send(data: Bytes | string): void {
      this.sent.push(data);
    }

    close(): void {
      this.closed = true;
      this.readyState = 3;
    }

    open(): void {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }

    drop(): void {
      this.readyState = 3;
      this.onclose?.(new Event('close') as CloseEvent);
    }

    message(data: unknown): void {
      this.onmessage?.(new MessageEvent('message', { data }));
    }
  }

  const latest = (): FakeSocket => FakeSocket.instances[FakeSocket.instances.length - 1] as FakeSocket;

  function client(onFrame: (f: Bytes) => void = () => undefined, statuses: string[] = []): BlindWebSocketClient {
    return new BlindWebSocketClient({
      url: 'wss://relay.example/ws',
      onFrame,
      getToken: () => `token-${FakeSocket.instances.length}`,
      onStatusChange: (s) => statuses.push(s),
      createSocket: (url, protocols) => new FakeSocket(url, protocols),
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 500,
      backoffBaseMs: 100,
      backoffMaxMs: 1_000,
      random: () => 1,
    });
  }

  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers the relay subprotocol with a fresh token on every connect', () => {
    const c = client();
    c.connect();
    expect(latest().protocols).toEqual(['ankylock.v1', 'token-0']);
    latest().drop();
    vi.advanceTimersByTime(1_000);
    expect(latest().protocols).toEqual(['ankylock.v1', 'token-1']);
    c.dispose();
  });

  it('sends only while open and delivers binary frames', () => {
    const frames: Bytes[] = [];
    const c = client((f) => frames.push(f));
    c.connect();
    expect(latest().binaryType).toBe('arraybuffer');
    expect(c.send(new Uint8Array([1]))).toBe(false);
    latest().open();
    expect(c.send(new Uint8Array([1]))).toBe(true);
    latest().message(new Uint8Array([9, 9]).buffer);
    latest().message('unknown control');
    expect(frames).toEqual([new Uint8Array([9, 9])]);
    c.dispose();
  });

  it('reconnects with capped exponential backoff and resets after a successful open', () => {
    const statuses: string[] = [];
    const c = client(undefined, statuses);
    c.connect();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      delays.push(c.nextBackoffMs());
      latest().drop();
      vi.advanceTimersByTime(c.nextBackoffMs() * 2); // any wait ≥ the scheduled delay
    }
    expect(delays).toEqual([100, 200, 400, 800, 1_000, 1_000]);
    expect(FakeSocket.instances).toHaveLength(7);
    latest().open();
    expect(c.nextBackoffMs()).toBe(100);
    expect(statuses).toContain('open');
    c.dispose();
  });

  it('applies jitter between 50 % and 100 % of the backoff ceiling', () => {
    const low = new BlindWebSocketClient({
      url: 'x',
      getToken: () => 't',
      onFrame: () => undefined,
      random: () => 0,
      backoffBaseMs: 100,
    });
    expect(low.nextBackoffMs()).toBe(50);
  });

  it('pings, stays connected on pong and reconnects when pong is missing', () => {
    const c = client();
    c.connect();
    latest().open();

    vi.advanceTimersByTime(1_000);
    expect(latest().sent).toContain(HEARTBEAT_PING);
    latest().message(HEARTBEAT_PONG);
    vi.advanceTimersByTime(600);
    expect(FakeSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(400); // next ping, no pong this time
    vi.advanceTimersByTime(500);
    expect(FakeSocket.instances[0]?.closed).toBe(true);
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
    c.dispose();
  });

  it('dispose detaches handlers and never reconnects', () => {
    const c = client();
    c.connect();
    const socket = latest();
    socket.open();
    c.dispose();
    expect(socket.onmessage).toBeNull();
    expect(socket.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
