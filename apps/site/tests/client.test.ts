import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCKED_EXPRESSIONS, UNLOCKED_EXPRESSIONS } from '@ankylock/web/logo';
import { afterEach, describe, expect, it } from 'vitest';
import { animateLogo } from '../src/client/logo.js';
import { setUpPreferences } from '../src/client/preferences.js';
import { MOTIONS } from '../src/logo.js';
import { LANGUAGE_KEY, THEME_KEY } from '../src/site.js';
import { renderedPages } from './helpers.js';

/** Loads a rendered page into the test document. */
function load(file: string): void {
  const doc = renderedPages().get(file);
  if (!doc) throw new Error(`no page ${file}`);
  document.documentElement.innerHTML = doc.documentElement.innerHTML;
  for (const name of doc.documentElement.getAttributeNames()) {
    document.documentElement.setAttribute(name, doc.documentElement.getAttribute(name) ?? '');
  }
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme and language preferences', () => {
  it('shows the theme switch, applies a choice and remembers it on this device only', () => {
    load('index.html');
    setUpPreferences(document);
    const group = document.querySelector('[data-theme-switch]');
    expect(group?.hasAttribute('hidden')).toBe(false);
    const button = (choice: string) => document.querySelector<HTMLButtonElement>(`[data-theme-choice="${choice}"]`);
    expect(button('system')?.getAttribute('aria-pressed')).toBe('true');

    button('dark')?.click();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(button('dark')?.getAttribute('aria-pressed')).toBe('true');
    expect(button('system')?.getAttribute('aria-pressed')).toBe('false');

    button('system')?.click();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
  });

  it('remembers the language a visitor picks', () => {
    load('index.html');
    setUpPreferences(document);
    const turkish = document.querySelector<HTMLAnchorElement>('a[data-language="tr"]');
    turkish?.addEventListener('click', (e) => e.preventDefault());
    turkish?.click();
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe('tr');
  });
});

describe('init.js', () => {
  const code = readFileSync(join(process.cwd(), 'src/init.js'), 'utf8');
  /** Runs the script with the page's globals stood in for. */
  function run(options: { languages: string[]; saved?: Record<string, string>; turkishPage?: string }) {
    const root = document.createElement('html');
    if (options.turkishPage) root.setAttribute('data-tr', options.turkishPage);
    const saved = new Map(Object.entries(options.saved ?? {}));
    const replaced: string[] = [];
    // The script is ours (src/init.js); running it with stand-ins is the point of the test.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const script = new Function('document', 'localStorage', 'navigator', 'location', code) as (...args: unknown[]) => void;
    script(
      { documentElement: root },
      { getItem: (k: string) => saved.get(k) ?? null },
      { languages: options.languages, language: options.languages[0] },
      { hash: '', replace: (url: string) => replaced.push(url) },
    );
    return { theme: root.getAttribute('data-theme'), replaced };
  }

  it('applies a saved theme before the page paints', () => {
    expect(run({ languages: ['en'], saved: { [THEME_KEY]: 'dark' } }).theme).toBe('dark');
    expect(run({ languages: ['en'], saved: { [THEME_KEY]: 'nonsense' } }).theme).toBeNull();
  });

  it('sends a first-time visitor whose browser prefers Turkish to the Turkish page, once', () => {
    expect(run({ languages: ['tr-TR', 'en'], turkishPage: '/tr/' }).replaced).toEqual(['/tr/']);
    expect(run({ languages: ['en-US', 'tr'], turkishPage: '/tr/' }).replaced).toEqual([]);
    expect(run({ languages: ['tr'], turkishPage: '/tr/', saved: { [LANGUAGE_KEY]: 'en' } }).replaced).toEqual([]);
    // A page without a Turkish version stays.
    expect(run({ languages: ['tr'] }).replaced).toEqual([]);
  });
});

describe('animated logo', () => {
  function logo(reduced = false) {
    load('index.html');
    const button = document.querySelector<HTMLButtonElement>('[data-logo]');
    if (!button) throw new Error('no logo');
    const svg = button.querySelector('svg') as SVGSVGElement;
    const shown = (state: 'locked' | 'unlocked') =>
      Array.from(svg.querySelectorAll<SVGGElement>(`[data-face="${state}"] [data-expression]`))
        .filter((g) => g.getAttribute('display') !== 'none')
        .map((g) => g.dataset['expression']);
    return { button, svg, set: animateLogo(button, reduced, () => 0.5), shown };
  }

  it('draws every expression once and starts locked on "arch"', () => {
    const { svg, shown } = logo();
    expect(svg.querySelectorAll('[data-face="locked"] [data-expression]')).toHaveLength(LOCKED_EXPRESSIONS.length);
    expect(svg.querySelectorAll('[data-face="unlocked"] [data-expression]')).toHaveLength(UNLOCKED_EXPRESSIONS.length);
    expect(svg.querySelectorAll('[data-motion]')).toHaveLength(MOTIONS.length);
    expect(shown('locked')).toEqual(['arch']);
    expect(svg.dataset['logoFace']).toBe('arch');
  });

  it('unlocks and locks on click with the app’s motions and a new expression each time', () => {
    const { button, svg, shown } = logo();
    const shackle = svg.querySelectorAll<SVGGElement>('[data-motion]')[1];
    button.click();
    expect(shackle?.style.transform).toBe(MOTIONS[1]?.unlocked);
    expect(svg.querySelector<SVGGElement>('[data-face="unlocked"]')?.style.opacity).toBe('1');
    expect(shown('unlocked')).toHaveLength(1);
    expect(svg.dataset['logoFace']).toBe(shown('unlocked')[0]);

    button.click();
    expect(shackle?.style.transform).toBe('none');
    expect(shown('locked')).toHaveLength(1);
    expect(shown('locked')).not.toEqual(['arch']);
  });

  it('switches without moving when the visitor asks for reduced motion', () => {
    const { set, svg } = logo(true);
    set(true);
    for (const group of Array.from(svg.querySelectorAll<SVGGElement>('[data-motion], [data-face]'))) expect(group.style.transition).toBe('none');
  });
});
