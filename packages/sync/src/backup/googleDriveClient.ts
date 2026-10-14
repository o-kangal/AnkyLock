import type { Bytes, EpochMs } from '@ankylock/core';

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

/** A file in appDataFolder. */
export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly modifiedTime: EpochMs;
}

const quote = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

const isDriveFile = (value: unknown): value is { id: string; name: string; modifiedTime: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { id?: unknown }).id === 'string' &&
  typeof (value as { name?: unknown }).name === 'string' &&
  typeof (value as { modifiedTime?: unknown }).modifiedTime === 'string';

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
      q: `name = ${quote(name)} and trashed = false`,
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

  /** Every file in appDataFolder whose name starts with `prefix`. */
  async listFiles(prefix: string): Promise<DriveFile[]> {
    const files: DriveFile[] = [];
    let pageToken: string | null = null;
    do {
      const query = new URLSearchParams({
        spaces: 'appDataFolder',
        q: `name contains ${quote(prefix)} and trashed = false`,
        fields: 'nextPageToken, files(id, name, modifiedTime)',
        pageSize: '100',
        ...(pageToken === null ? {} : { pageToken }),
      });
      const body: unknown = await (await this.#request(`${FILES_URL}?${query.toString()}`)).json();
      const page = body as { files?: unknown; nextPageToken?: unknown };
      for (const file of Array.isArray(page.files) ? page.files : []) {
        if (isDriveFile(file) && file.name.startsWith(prefix)) {
          files.push({ id: file.id, name: file.name, modifiedTime: Date.parse(file.modifiedTime) as EpochMs });
        }
      }
      pageToken = typeof page.nextPageToken === 'string' ? page.nextPageToken : null;
    } while (pageToken !== null);
    return files;
  }

  /** Creates the file in appDataFolder, or replaces the content of the existing one. */
  async upload(name: string, data: Bytes, mimeType: string): Promise<void> {
    const existing = await this.findFileId(name);
    if (existing === null) {
      await this.create(name, data, mimeType);
      return;
    }
    await this.#request(`${UPLOAD_URL}/${encodeURIComponent(existing)}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body: data,
    });
  }

  /** Always adds a new file, never touching existing ones. */
  async create(name: string, data: Bytes, mimeType: string): Promise<void> {
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
    return id === null ? null : this.downloadFile(id);
  }

  async downloadFile(id: string): Promise<Bytes> {
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
