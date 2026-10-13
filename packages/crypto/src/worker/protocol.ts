import type { Bytes, SealedBytes } from '@ankylock/core';
import type { CryptoErrorCode } from '../errors.js';

/** The subset of `MessagePort`, `Worker` and a worker's global scope used by the crypto bridge. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  start?(): void;
}

export type CryptoRequest =
  | { readonly id: number; readonly op: 'setKey'; readonly key: CryptoKey | null }
  | { readonly id: number; readonly op: 'seal'; readonly data: Bytes }
  | { readonly id: number; readonly op: 'open'; readonly data: SealedBytes };

export type CryptoResponse =
  | { readonly id: number; readonly ok: true; readonly data: Bytes | null }
  | { readonly id: number; readonly ok: false; readonly code: CryptoErrorCode; readonly message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

export function isCryptoRequest(value: unknown): value is CryptoRequest {
  if (!isObject(value) || typeof value['id'] !== 'number') return false;
  switch (value['op']) {
    case 'setKey':
      return value['key'] === null || value['key'] instanceof CryptoKey;
    case 'seal':
    case 'open':
      return value['data'] instanceof Uint8Array;
    default:
      return false;
  }
}

export function isCryptoResponse(value: unknown): value is CryptoResponse {
  if (!isObject(value) || typeof value['id'] !== 'number') return false;
  return value['ok'] === true
    ? value['data'] === null || value['data'] instanceof Uint8Array
    : value['ok'] === false && typeof value['code'] === 'string' && typeof value['message'] === 'string';
}
