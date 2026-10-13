import type { Bytes } from '@ankylock/core';

const FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';

/**
 * - `auth`: token missing, expired or lacking the `drive.appdata` scope (HTTP 401/403).
 * - `quota`: the user's Drive is full (HTTP 403 `storageQuotaExceeded`).
 * - `network`: no response at all.
 * - `http`: any other unexpected status.
 */
export type DriveErrorKind = 'auth' | 'quota' | 'network' | 'http';

export class DriveError extends Error {
  readonly kind: DriveErrorKind;
  readonly status: number | null;

  constructor(kind: DriveErrorKind, status: number | null, message: string) {
    super(message);
    this.name = 'DriveError';
    this.kind = kind;
    this.status = status;
  }
}

export interface GoogleDriveClientOptions {
  /**
   * OAuth access token with only the `https://www.googleapis.com/auth/drive.appdata` scope.
   * Used for Drive access, never for key material (BR-SEC-03).
   */
  readonly getAccessToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

/**
 * Minimal Drive v3 REST client for the hidden `appDataFolder`: the app sees only its own files
 * there and the user's Drive is never listed. Every uploaded byte is already encrypted.
 */
export class GoogleDriveClient {
  readonly #getAccessToken: () => Promise<string>;
  readonly #fetch: typeof fetch;

  constructor(options: GoogleDriveClientOptions) {
    this.#getAccessToken = options.getAccessToken;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async #request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${await this.#getAccessToken()}`);
    let response: Response;
    try {
      response = await this.#fetch(url, { ...init, headers });
    } catch (error) {
      throw new DriveError('network', null, error instanceof Error ? error.message : 'Network request failed.');
    }
    if (response.ok) return response;
    throw await toDriveError(response);
  }

  /** Id of the newest file with this exact name in appDataFolder, or null. */
  async findFileId(name: string): Promise<string | null> {
    const query = new URLSearchParams({
      spaces: 'appDataFolder',
      q: `name = '${name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}' and trashed = false`,
      fields: 'files(id)',
      orderBy: 'modifiedTime desc',
      pageSize: '1',
    });
    const body: unknown = await (await this.#request(`${FILES_URL}?${query.toString()}`)).json();
    const files = (body as { files?: unknown }).files;
    const first: unknown = Array.isArray(files) ? files[0] : undefined;
    const id = typeof first === 'object' && first !== null ? (first as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? id : null;
  }

  /** Creates the file in appDataFolder, or replaces the content of the existing one. */
  async upload(name: string, data: Bytes, mimeType: string): Promise<void> {
    const existing = await this.findFileId(name);
    if (existing !== null) {
      await this.#request(`${UPLOAD_URL}/${encodeURIComponent(existing)}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': mimeType },
        body: data,
      });
      return;
    }
    const boundary = `ankylock-${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ name, parents: ['appDataFolder'], mimeType });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      data,
      `\r\n--${boundary}--`,
    ]);
    await this.#request(`${UPLOAD_URL}?uploadType=multipart`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }

  async download(name: string): Promise<Bytes | null> {
    const id = await this.findFileId(name);
    if (id === null) return null;
    const response = await this.#request(`${FILES_URL}/${encodeURIComponent(id)}?alt=media`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

async function toDriveError(response: Response): Promise<DriveError> {
  let reason = '';
  try {
    const body: unknown = await response.json();
    const errors = (body as { error?: { errors?: { reason?: unknown }[] } }).error?.errors;
    reason = typeof errors?.[0]?.reason === 'string' ? errors[0].reason : '';
  } catch {
    // Non-JSON error body; the status alone decides.
  }
  if (response.status === 403 && reason === 'storageQuotaExceeded') {
    return new DriveError('quota', 403, 'Google Drive storage is full.');
  }
  if (response.status === 401 || response.status === 403) {
    return new DriveError('auth', response.status, 'Google Drive authorization failed.');
  }
  return new DriveError('http', response.status, `Google Drive request failed with HTTP ${response.status}.`);
}
