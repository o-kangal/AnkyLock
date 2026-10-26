import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { cspViolations, servePagesHeaders, watchCsp } from './pagesHeaders.js';
import { SITE_HEADERS, SITE_ORIGIN } from './origins.js';

test.describe('under the site’s _headers', () => {
  test.beforeEach(async ({ context, page }) => {
    await servePagesHeaders(context, SITE_ORIGIN, SITE_HEADERS);
    await watchCsp(page);
  });

  test('every page works under the production CSP: scripts, styles, fonts, images', async ({ page }) => {
    for (const path of ['/', '/tr/', '/download/', '/tr/download/', '/privacy/', '/terms/', '/404.html']) {
      const response = await page.goto(SITE_ORIGIN + path);
      expect(response?.headers()['content-security-policy'], path).toContain("default-src 'none'");
      // The script ran: it reveals the theme switch.
      await expect(page.locator('[data-theme-switch]'), path).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.fonts.check('16px "Plus Jakarta Sans Variable"')), path).toBe(true);
      expect(await cspViolations(page), path).toEqual([]);
    }
    await page.goto(SITE_ORIGIN + '/');
    await page.locator('.screenshot').scrollIntoViewIfNeeded();
    await expect.poll(() => page.locator('.screenshot').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1600);
    expect(await cspViolations(page)).toEqual([]);
  });

  test('remembers the theme on this device, applied before the page paints', async ({ page }) => {
    await page.goto(SITE_ORIGIN + '/');
    await page.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(30, 30, 30)');
  });

  test('locks and unlocks the logo on click', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(SITE_ORIGIN + '/');
    const logo = page.locator('[data-logo] svg');
    await expect(logo).toHaveAttribute('data-logo-face', 'arch');
    await page.locator('[data-logo]').click();
    await expect(logo).not.toHaveAttribute('data-logo-face', 'arch');
    expect(await cspViolations(page)).toEqual([]);
  });

  test.describe('a browser that prefers Turkish', () => {
    test.use({ locale: 'tr-TR' });

    test('opens the Turkish site on a first visit, and keeps the language the visitor picks', async ({ page }) => {
      await page.goto(SITE_ORIGIN + '/download/');
      await expect(page).toHaveURL(`${SITE_ORIGIN}/tr/download/`);
      await expect(page.locator('h1')).toHaveText('AnkyLock’u indirin');
      await page.getByRole('navigation', { name: 'Dil' }).getByRole('link', { name: 'English' }).click();
      await expect(page).toHaveURL(`${SITE_ORIGIN}/download/`);
      await page.goto(SITE_ORIGIN + '/');
      await expect(page).toHaveURL(`${SITE_ORIGIN}/`);
    });
  });
});

// Without this, "no violations" above could mean the watcher sees nothing.
test('reports violations when a policy blocks what the page needs', async ({ context, page }) => {
  const file = join(mkdtempSync(join(tmpdir(), 'ankylock-headers-')), '_headers');
  writeFileSync(file, "/*\n  Content-Security-Policy: default-src 'none'; script-src 'self'\n");
  await servePagesHeaders(context, SITE_ORIGIN, file);
  await watchCsp(page);
  await page.goto(SITE_ORIGIN + '/');
  await expect.poll(async () => (await cspViolations(page)).some((v) => v.startsWith('style-src'))).toBe(true);
});
