import type { BrowserContext, Route } from '@playwright/test';

/** Must match `VITE_GOOGLE_CLIENT_ID` of the build under test (see playwright.config.ts). */
export const CLIENT_ID = 'ankylock-browser-test.apps.googleusercontent.com';
export const EMAIL = 'tester@example.com';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
};

const base64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

interface DriveFile {
  name: string;
  data: Buffer;
  modifiedTime: number;
}

/**
 * Google sign-in and the Drive appDataFolder REST calls the app makes, served in memory to every
 * page of the contexts it is installed on; nothing reaches Google. Contexts sharing one instance
 * are two devices of the same account.
 */
export class FakeGoogle {
  readonly files = new Map<string, DriveFile>();
  #next = 0;

  /** Every Drive file's bytes, decoded as text: what Google would see of the vault. */
  driveContents(): string {
    return [...this.files.values()].map((f) => `${f.name}\n${f.data.toString('latin1')}`).join('\n');
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route('https://accounts.google.com/**', (route) => this.#authorize(route));
    await context.route('https://oauth2.googleapis.com/**', (route) => route.fulfill({ status: 200, headers: CORS }));
    await context.route('https://www.googleapis.com/**', (route) => this.#drive(route));
  }

  /** Consents at once: redirects to the callback page with tokens for the request's nonce. */
  #authorize(route: Route): Promise<void> {
    const query = new URL(route.request().url()).searchParams;
    const idToken = [
      base64url({ alg: 'none', typ: 'JWT' }),
      base64url({ iss: 'https://accounts.google.com', aud: query.get('client_id'), nonce: query.get('nonce'), email: EMAIL, sub: '1' }),
      'signature',
    ].join('.');
    const fragment = new URLSearchParams({
      state: query.get('state') ?? '',
      access_token: 'fake-access-token',
      id_token: idToken,
      expires_in: '3600',
      token_type: 'Bearer',
      scope: query.get('scope') ?? '',
    });
    const target = JSON.stringify(`${query.get('redirect_uri') ?? ''}#${fragment.toString()}`).replaceAll('<', '\\u003c');
    // A page that navigates on, not a 302: WebKit cannot fulfill a route with a redirect.
    return route.fulfill({ status: 200, contentType: 'text/html', body: `<script>location.replace(${target})</script>` });
  }

  async #drive(route: Route): Promise<void> {
    const request = route.request();
    // `headers()` leaves out Authorization in WebKit; `allHeaders()` has them all.
    const headers = await request.allHeaders();
    const method = request.method();
    const url = new URL(request.url());
    const json = (value: unknown): Promise<void> =>
      route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    const missing = (): Promise<void> => route.fulfill({ status: 404, headers: CORS, body: 'not found' });
    const fileId = /\/files\/([^/?]+)$/.exec(url.pathname)?.[1];
    const file = fileId === undefined ? undefined : this.files.get(decodeURIComponent(fileId));

    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (headers['authorization'] !== 'Bearer fake-access-token') {
      return route.fulfill({ status: 401, headers: CORS, body: 'unauthorized' });
    }
    if (method === 'GET' && fileId !== undefined) {
      return file ? route.fulfill({ status: 200, headers: CORS, body: file.data }) : missing();
    }
    if (method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const exact = /^name = '(.*)' and trashed = false$/.exec(q)?.[1];
      const prefix = /^name contains '(.*)' and trashed = false$/.exec(q)?.[1] ?? '';
      const files = [...this.files.entries()]
        .filter(([, f]) => (exact !== undefined ? f.name === exact : f.name.includes(prefix)))
        .sort(([, a], [, b]) => b.modifiedTime - a.modifiedTime)
        .map(([id, f]) => ({ id, name: f.name, modifiedTime: new Date(f.modifiedTime).toISOString() }));
      return json({ files });
    }
    if (method === 'DELETE' && fileId !== undefined) {
      if (!file) return missing();
      this.files.delete(decodeURIComponent(fileId));
      return route.fulfill({ status: 204, headers: CORS });
    }
    if (method === 'PATCH' && fileId !== undefined) {
      if (!file) return missing();
      file.data = request.postDataBuffer() ?? Buffer.alloc(0);
      file.modifiedTime = Date.now();
      return json({ id: fileId });
    }
    if (method === 'POST') {
      // Multipart body: a metadata JSON part, then the raw file part. latin1 keeps byte offsets.
      const body = request.postDataBuffer() ?? Buffer.alloc(0);
      const text = body.toString('latin1');
      const boundary = /boundary=(.+)$/.exec(headers['content-type'] ?? '')?.[1] ?? '';
      const [, metaPart = '', dataPart = ''] = text.split(`--${boundary}`);
      const metadata = JSON.parse(metaPart.split('\r\n\r\n')[1] ?? '{}') as { name: string };
      const dataStart = text.indexOf('\r\n\r\n', text.indexOf(dataPart)) + 4;
      const dataEnd = text.lastIndexOf(`\r\n--${boundary}--`);
      const id = `file-${String(++this.#next)}`;
      this.files.set(id, { name: metadata.name, data: body.subarray(dataStart, dataEnd), modifiedTime: Date.now() });
      return json({ id });
    }
    return route.fulfill({ status: 400, headers: CORS, body: 'unsupported' });
  }
}
