import type { Bytes } from '@ankylock/core';
import type { PacketTransport } from '../queue/outboxQueue.js';

/** The subset of the browser `WebSocket` this client uses; injectable for tests. */
export interface SocketLike {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: Bytes | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

/** First offered subprotocol; the relay echoes it back. The second offered value is the token. */
export const RELAY_SUBPROTOCOL = 'ankylock.v1';

export interface BlindWebSocketClientOptions {
  readonly url: string;
  /**
   * Returns a current Google ID token. Called on every (re)connect because ID tokens expire
   * after an hour. Sent as a subprotocol: browsers can't set WebSocket headers and URLs get logged.
   */
  readonly getToken: () => string;
  /** Receives every binary frame from the relay (data). Text frames are control messages. */
  readonly onFrame: (frame: Bytes) => void;
  readonly onStatusChange?: (status: ConnectionStatus) => void;
  readonly createSocket?: (url: string, protocols: string[]) => SocketLike;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly random?: () => number;
}

const OPEN = 1;

/** Realm-independent: buffers may come from another realm (iframes, workers, test environments). */
const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';
/**
 * Browsers cannot send WebSocket ping frames, so the heartbeat is an application-level text
 * frame. The relay answers `ping` with `pong` and forwards only binary frames between peers.
 */
export const HEARTBEAT_PING = 'ping';
export const HEARTBEAT_PONG = 'pong';
const HEARTBEAT_TIMEOUT_CLOSE_CODE = 4000;

/**
 * Persistent connection to the blind relay: exponential backoff with jitter (capped), heartbeat
 * with dead-connection detection, and full listener cleanup on dispose.
 */
export class BlindWebSocketClient implements PacketTransport {
  readonly #options: Required<Omit<BlindWebSocketClientOptions, 'onStatusChange'>> &
    Pick<BlindWebSocketClientOptions, 'onStatusChange'>;
  #socket: SocketLike | null = null;
  #attempt = 0;
  #disposed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  #pongDeadline: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BlindWebSocketClientOptions) {
    this.#options = {
      createSocket: (url, protocols) => new WebSocket(url, protocols),
      heartbeatIntervalMs: 25_000,
      heartbeatTimeoutMs: 10_000,
      backoffBaseMs: 500,
      backoffMaxMs: 30_000,
      random: Math.random,
      ...options,
    };
  }

  get isOpen(): boolean {
    return this.#socket?.readyState === OPEN;
  }

  connect(): void {
    if (this.#disposed || this.#socket) return;
    const socket = this.#options.createSocket(this.#options.url, [RELAY_SUBPROTOCOL, this.#options.getToken()]);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      this.#attempt = 0;
      this.#startHeartbeat();
      this.#options.onStatusChange?.('open');
    };
    socket.onmessage = (event) => this.#onMessage(event.data);
    socket.onclose = () => this.#teardown(true);
    // An error is always followed by close; reconnect is handled there.
    socket.onerror = () => undefined;
    this.#socket = socket;
    this.#options.onStatusChange?.('connecting');
  }

  send(frame: Bytes): boolean {
    if (!this.#socket || this.#socket.readyState !== OPEN) return false;
    this.#socket.send(frame);
    return true;
  }

  /** Closes the connection for good and releases every handler and timer. */
  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#reconnectTimer);
    this.#teardown(false);
  }

  /** Delay before the next reconnect attempt: base · 2^attempt capped at max, with 50–100 % jitter. */
  nextBackoffMs(): number {
    const { backoffBaseMs, backoffMaxMs, random } = this.#options;
    const ceiling = Math.min(backoffMaxMs, backoffBaseMs * 2 ** this.#attempt);
    return ceiling * (0.5 + random() * 0.5);
  }

  #onMessage(data: unknown): void {
    if (isArrayBuffer(data)) this.#options.onFrame(new Uint8Array(data));
    else if (data === HEARTBEAT_PONG) clearTimeout(this.#pongDeadline);
  }

  #startHeartbeat(): void {
    this.#heartbeatTimer = setInterval(() => {
      this.#socket?.send(HEARTBEAT_PING);
      clearTimeout(this.#pongDeadline);
      this.#pongDeadline = setTimeout(() => {
        // No pong: the connection is dead even if the browser has not noticed yet.
        this.#socket?.close(HEARTBEAT_TIMEOUT_CLOSE_CODE, 'heartbeat timeout');
        this.#teardown(true);
      }, this.#options.heartbeatTimeoutMs);
    }, this.#options.heartbeatIntervalMs);
  }

  #teardown(reconnect: boolean): void {
    clearInterval(this.#heartbeatTimer);
    clearTimeout(this.#pongDeadline);
    const socket = this.#socket;
    if (socket) {
      socket.onopen = socket.onclose = socket.onmessage = socket.onerror = null;
      if (socket.readyState === OPEN || socket.readyState === 0) socket.close();
      this.#socket = null;
      this.#options.onStatusChange?.('closed');
    }
    if (reconnect && !this.#disposed && this.#reconnectTimer === undefined) {
      const delay = this.nextBackoffMs();
      this.#attempt++;
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = undefined;
        this.connect();
      }, delay);
    }
  }
}
