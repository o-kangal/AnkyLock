import { expect, test } from '@playwright/test';
import { FakeGoogle } from './fakeGoogle.js';
import { APP_HEADERS, APP_ORIGIN } from './origins.js';
import { cspViolations, servePagesHeaders, watchCsp } from './pagesHeaders.js';
import { createVault, PASSPHRASE, writeNote } from './steps.js';

// Google is faked for every page: these tests never sign in, and nothing may reach the network.
test.beforeEach(async ({ context, page }) => {
  await new FakeGoogle().install(context);
  await servePagesHeaders(context, APP_ORIGIN, APP_HEADERS);
  await watchCsp(page);
});

// Every flow runs under the production CSP header; none may trip it.
test.afterEach(async ({ page }) => {
  expect(await cspViolations(page)).toEqual([]);
});

test('creates a vault, keeps a note through lock and unlock', async ({ page }) => {
  await createVault(page);
  await writeNote(page, 'Shopping list\n- oat milk');
  await expect(page.getByRole('navigation').or(page.locator('aside')).getByText('Shopping list').first()).toBeVisible();

  await page.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();

  await page.getByLabel('Passphrase', { exact: true }).fill('not the passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toHaveText('The passphrase does not unlock this vault.');

  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.locator('aside').getByText('Shopping list').click();
  await expect(page.locator('.cm-content')).toContainText('- oat milk');
});

test('stores notes encrypted: no plaintext in IndexedDB', async ({ page }) => {
  await createVault(page);
  await writeNote(page, 'Secret plan: launch on Friday');
  // Saves are debounced; wait until the note shows up as saved in the sidebar.
  await expect(page.locator('aside').getByText('Secret plan: launch on Friday')).toBeVisible();
  await page.waitForTimeout(1_000);

  const dump = await page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name).filter((n): n is string => typeof n === 'string');
    const values: string[] = [];
    for (const name of names) {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error(`cannot open ${name}`));
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const all = await new Promise<unknown[]>((resolve) => {
          const request = db.transaction(store).objectStore(store).getAll();
          request.onsuccess = () => resolve(request.result as unknown[]);
        });
        values.push(JSON.stringify(all, (_key, value: unknown) => (value instanceof Uint8Array ? new TextDecoder().decode(value) : value)));
      }
      db.close();
    }
    return values.join('\n');
  });
  expect(dump.length).toBeGreaterThan(0);
  expect(dump).not.toContain('Secret plan');
  expect(dump).not.toContain('Personal');
});

test('refuses a short passphrase and warns about an easy one', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Vault name').fill('Personal');
  await page.getByLabel('Passphrase', { exact: true }).fill('short');
  await page.getByLabel('Confirm passphrase').fill('short');
  await page.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByRole('alert')).toHaveText('Use at least 12 characters.');

  await page.getByLabel('Passphrase', { exact: true }).fill('123456789012');
  await expect(page.getByText('This passphrase is easy to guess.')).toBeVisible();
});

test('exports a note as a text file after a warning', async ({ page }) => {
  await createVault(page);
  await writeNote(page, 'Export me\nsecond line');
  await page.locator('aside').getByText('Export me').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Export…' }).click();
  await expect(page.getByText('Exported files are not protected by AnkyLock.')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const file = await download;
  // The app names the file after the title; WebKit's downloads turn spaces into underscores.
  expect(file.suggestedFilename()).toMatch(/^Export[ _]me\.txt$/);
  const path = await file.path();
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(path, 'utf8')).toBe('Export me\nsecond line');
});

test('switches theme and language, and remembers them', async ({ page }) => {
  await createVault(page);
  await page.getByRole('button', { name: /^Personal/ }).click();
  await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'Türkçe' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.getByRole('button', { name: 'Kilitle', exact: true }).first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Kasanızın kilidini açın' })).toBeVisible();
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
});
