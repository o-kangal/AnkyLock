import { expect, type Page } from '@playwright/test';

export const PASSPHRASE = 'blue cat drinks tea';

/** Creates a vault named `name` from the first-run screen and waits for the workspace. */
export async function createVault(page: Page, name = 'Personal'): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create a vault' })).toBeVisible();
  await page.getByLabel('Vault name').fill(name);
  await page.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await page.getByLabel('Confirm passphrase').fill(PASSPHRASE);
  await page.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
}

/** Opens a new scratchpad and types into it. */
export async function writeNote(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).click();
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.type(text);
}
