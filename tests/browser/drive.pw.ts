import { expect, test } from '@playwright/test';
import { FakeGoogle } from './fakeGoogle.js';
import { APP_HEADERS, APP_ORIGIN } from './origins.js';
import { cspViolations, servePagesHeaders, watchCsp } from './pagesHeaders.js';
import { createVault, PASSPHRASE, writeNote } from './steps.js';

test('backs a vault up to Google Drive, encrypted, and opens it on a second device', async ({ browser, browserName }) => {
  // Playwright cannot read Blob request bodies in WebKit, so the fake Drive would get empty uploads.
  // The Drive client is plain `fetch`, the same in every engine.
  test.skip(browserName === 'webkit', 'request bodies are not readable in WebKit');
  const google = new FakeGoogle();
  const laptop = await browser.newContext();
  await google.install(laptop);
  await servePagesHeaders(laptop, APP_ORIGIN, APP_HEADERS);
  const first = await laptop.newPage();
  await watchCsp(first);

  await createVault(first, 'Work');
  await first.getByRole('button', { name: 'Sign in with Google' }).click();
  await expect(first.getByText('Synced via Google Drive')).toBeVisible();
  await writeNote(first, 'Release checklist\n- tag v1.0');
  await expect(first.locator('aside').getByText('Release checklist')).toBeVisible();
  // Locking backs the vault up before the key is forgotten.
  await first.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(first.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible();
  await expect.poll(() => google.files.size).toBeGreaterThanOrEqual(2);

  const drive = google.driveContents();
  for (const plaintext of ['Release checklist', 'tag v1.0', 'Work']) expect(drive).not.toContain(plaintext);

  const phone = await browser.newContext();
  await google.install(phone);
  await servePagesHeaders(phone, APP_ORIGIN, APP_HEADERS);
  const second = await phone.newPage();
  await watchCsp(second);
  await second.goto('/');
  await second.getByRole('button', { name: 'Use my existing vault' }).click();
  await expect(second.getByRole('combobox', { name: 'Vault in Google Drive' })).toBeVisible();
  await second.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await second.getByRole('button', { name: 'Open vault' }).click();
  await second.locator('aside').getByText('Release checklist').click();
  await expect(second.locator('.cm-content')).toContainText('- tag v1.0');

  expect(await cspViolations(first)).toEqual([]);
  expect(await cspViolations(second)).toEqual([]);
  await laptop.close();
  await phone.close();
});
