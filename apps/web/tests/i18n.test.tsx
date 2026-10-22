import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import { VaultSettings } from '../src/components/VaultSettings.jsx';
import { createRuntime } from '../src/index.js';
import { en } from '../src/i18n/en.js';
import { tr } from '../src/i18n/tr.js';
import {
  chooseLocale,
  compareNames,
  errorText,
  formatTime,
  locale,
  resetLocaleForTests,
  systemLocale,
  t,
  tn,
} from '../src/i18n/index.js';
import { PASSPHRASE, TestVaults, localSealer } from './helpers.js';

class MemoryStorage {
  readonly items = new Map<string, string>();
  getItem = (key: string): string | null => this.items.get(key) ?? null;
  setItem = (key: string, value: string): void => void this.items.set(key, value);
}

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  resetLocaleForTests(new MemoryStorage());
});

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('dictionaries', () => {
  it('translate every key, with the same placeholders and no empty text', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
    for (const [key, english] of Object.entries(en)) {
      const turkish = tr[key as keyof typeof en];
      expect(english.trim(), key).not.toBe('');
      expect(turkish.trim(), key).not.toBe('');
      expect(placeholders(turkish), key).toEqual(placeholders(english));
    }
  });

  it('pair every plural form', () => {
    const keys = Object.keys(en);
    for (const key of keys.filter((k) => k.endsWith('.one'))) expect(keys).toContain(key.replace(/\.one$/, '.other'));
  });
});

describe('language choice', () => {
  it('follows the system language until the user picks one, and remembers the pick', () => {
    expect(systemLocale(['tr-TR', 'en-US'])).toBe('tr');
    expect(systemLocale(['tr'])).toBe('tr');
    expect(systemLocale(['en-GB', 'tr-TR'])).toBe('en');
    expect(systemLocale(['de-DE'])).toBe('en');
    expect(systemLocale([])).toBe('en');

    const storage = new MemoryStorage();
    resetLocaleForTests(storage);
    expect(locale()).toBe('en');
    expect(t('sync.lock')).toBe('Lock');
    chooseLocale('tr');
    expect(t('sync.lock')).toBe('Kilitle');
    expect(storage.items.get('ankylock.locale')).toBe('tr');

    // A reload reads the saved choice.
    resetLocaleForTests(storage);
    expect(locale()).toBe('tr');
    chooseLocale('system');
    expect(locale()).toBe('en');
  });

  it('fills in parameters as text, never as markup', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = render(() => <span>{t('menu.actionsFor', { name: '<img src=x onerror=alert(1)>' })}</span>, root);
    disposers.push(() => {
      dispose();
      root.remove();
    });
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toBe('Actions for <img src=x onerror=alert(1)>');
  });
});

describe('locale formats', () => {
  it('writes times the way each language does', () => {
    const evening = new Date(2026, 9, 23, 18, 5).getTime();
    expect(formatTime(evening)).toBe('06:05 PM');
    chooseLocale('tr');
    expect(formatTime(evening)).toBe('18:05');
  });

  it('sorts names in Turkish alphabetical order', () => {
    chooseLocale('tr');
    const names = ['şemsiye', 'sabun', 'çay', 'cam', 'izmir', 'ılık', 'Ödev', 'ocak', 'Ünite', 'uzun', 'Not 10', 'Not 2'];
    expect([...names].sort(compareNames)).toEqual([
      'cam',
      'çay',
      'ılık',
      'izmir',
      'Not 2',
      'Not 10',
      'ocak',
      'Ödev',
      'sabun',
      'şemsiye',
      'uzun',
      'Ünite',
    ]);
  });

  it('chooses plural forms by count', () => {
    expect(tn('trash.retentionConfirm', 1)).toBe('1 item in Trash will be deleted permanently now. Continue?');
    expect(tn('trash.retentionConfirm', 3)).toBe('3 items in Trash will be deleted permanently now. Continue?');
    chooseLocale('tr');
    expect(tn('trash.retentionConfirm', 3)).toBe('Çöp Kutusundaki 3 öğe şimdi kalıcı olarak silinecek. Devam edilsin mi?');
  });

  it("shows the packages' English errors in English, and translates them by code otherwise", () => {
    const error = { code: 'ERR_MAX_DEPTH_EXCEEDED', message: 'Folders can nest at most 3 levels deep.' };
    expect(errorText(error)).toBe('Folders can nest at most 3 levels deep.');
    chooseLocale('tr');
    expect(errorText(error)).toBe('Klasörler en fazla 3 seviye iç içe olabilir.');
    expect(errorText({ code: 'ERR_STORAGE', message: 'Transaction aborted.' })).toBe('Bu cihaza kaydetme başarısız oldu: Transaction aborted.');
    expect(errorText({ code: 'ERR_SOMETHING_NEW', message: 'Something new.' })).toBe('Something new.');
  });
});

describe('switching the language in the settings', () => {
  it('translates the open UI at once and back again', async () => {
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer() });
    await runtime.init();
    expect(await runtime.createVault('Kişisel', PASSPHRASE)).toBeNull();
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = render(() => <VaultSettings runtime={runtime} onClose={() => undefined} />, root);
    disposers.push(() => {
      dispose();
      root.remove();
    });
    const button = (text: string): HTMLButtonElement =>
      Array.from(root.querySelectorAll('button')).find((b) => b.textContent === text) as HTMLButtonElement;

    expect(button('Lock')).toBeDefined();
    button('Türkçe').click();
    expect(locale()).toBe('tr');
    expect(button('Kilitle')).toBeDefined();
    expect(button('Türkçe').getAttribute('aria-pressed')).toBe('true');
    expect(root.textContent).toContain('Dil (bu cihaz)');
    button('English').click();
    expect(button('Lock')).toBeDefined();
    await runtime.lock();
  });
});
