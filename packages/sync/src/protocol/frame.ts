import type { Brand, Bytes, EpochMs, SealedBytes, SyncOutboxEntry } from '@ankylock/core';
import { base64ToBytes, bytesToBase64 } from '@ankylock/crypto';

export const PROTOCOL_VERSION = 1;

/** Minimum sealed envelope: 12-byte IV + 16-byte tag. */
const MIN_ENVELOPE_LENGTH = 28;

export type DeviceId = Brand<string, 'DeviceId'>;

export type PacketType = 'CRDT_DELTA' | 'HIERARCHY_MUTATION' | 'TOMBSTONE';

/** Decoded relay frame. Only these fields are visible to the relay; `payload` is opaque. */
export interface SyncPacket {
  readonly packetType: PacketType;
  readonly entityId: SyncOutboxEntry['entityId'];
  readonly senderDeviceId: DeviceId;
  readonly timestampMs: EpochMs;
  readonly payload: SealedBytes;
}

export type FrameDecodeResult =
  | { readonly ok: true; readonly packet: SyncPacket }
  | { readonly ok: false; readonly reason: string };

const PACKET_TYPES: readonly string[] = ['CRDT_DELTA', 'HIERARCHY_MUTATION', 'TOMBSTONE'];

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Serializes the SPEC §5.2 envelope as UTF-8 JSON for a binary WebSocket frame. */
export function encodeFrame(packet: SyncPacket): Bytes {
  return encoder.encode(
    JSON.stringify({
      protocol_version: PROTOCOL_VERSION,
      packet_type: packet.packetType,
      entity_id: packet.entityId,
      sender_device_id: packet.senderDeviceId,
      timestamp_ms: packet.timestampMs,
      encrypted_envelope: bytesToBase64(packet.payload),
    }),
  );
}

/** Never throws: malformed frames or unknown protocol versions are reported and skipped. */
export function decodeFrame(frame: Bytes): FrameDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(frame));
  } catch {
    return { ok: false, reason: 'Frame is not valid UTF-8 JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'Frame is not an object.' };
  const f = parsed as Record<string, unknown>;

  if (f['protocol_version'] !== PROTOCOL_VERSION) {
    return { ok: false, reason: `Unsupported protocol version: ${String(f['protocol_version'])}.` };
  }
  const packetType = f['packet_type'];
  const entityId = f['entity_id'];
  const senderDeviceId = f['sender_device_id'];
  const timestampMs = f['timestamp_ms'];
  const envelope = f['encrypted_envelope'];
  if (
    typeof packetType !== 'string' ||
    !PACKET_TYPES.includes(packetType) ||
    typeof entityId !== 'string' ||
    typeof senderDeviceId !== 'string' ||
    typeof timestampMs !== 'number' ||
    typeof envelope !== 'string'
  ) {
    return { ok: false, reason: 'Frame is missing or has invalid fields.' };
  }

  let payload: Bytes;
  try {
    payload = base64ToBytes(envelope);
  } catch {
    return { ok: false, reason: 'Encrypted envelope is not valid base64.' };
  }
  if (payload.length < MIN_ENVELOPE_LENGTH) return { ok: false, reason: 'Encrypted envelope is too short.' };

  return {
    ok: true,
    packet: {
      packetType: packetType as PacketType,
      entityId: entityId as SyncPacket['entityId'],
      senderDeviceId: senderDeviceId as DeviceId,
      timestampMs: timestampMs as EpochMs,
      payload: payload as SealedBytes,
    },
  };
}
