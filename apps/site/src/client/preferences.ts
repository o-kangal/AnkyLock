import { LANGUAGE_KEY, THEME_KEY } from '../site.js';

export type ThemeChoice = 'system' | 'light' | 'dark';

/** Storage can be missing or blocked (private modes, strict settings); choices then last a page. */
function store(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readTheme(): ThemeChoice {
  const saved = store()?.getItem(THEME_KEY);
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

/** Applies a theme to the page (`data-theme`, read by the stylesheet) and remembers it. */
export function applyTheme(root: HTMLElement, choice: ThemeChoice): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') store()?.removeItem(THEME_KEY);
    else store()?.setItem(THEME_KEY, choice);
  } catch {
    // Not remembered; the page still shows the choice.
  }
}

/** Remembers the visitor's language, so the Turkish redirect in init.js stops for good. */
export function rememberLanguage(language: string): void {
  try {
    store()?.setItem(LANGUAGE_KEY, language);
  } catch {
    // Not remembered: the link still leads to the chosen language.
  }
}

/** Wires the footer's theme buttons and language links, and shows the theme switch. */
export function setUpPreferences(doc: Document): void {
  const root = doc.documentElement;
  const group = doc.querySelector<HTMLElement>('[data-theme-switch]');
  const buttons = Array.from(doc.querySelectorAll<HTMLButtonElement>('[data-theme-choice]'));
  const show = (choice: ThemeChoice): void => {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset['themeChoice'] === choice));
  };
  show(readTheme());
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const choice = button.dataset['themeChoice'];
      if (choice !== 'system' && choice !== 'light' && choice !== 'dark') return;
      applyTheme(root, choice);
      show(choice);
    });
  }
  group?.removeAttribute('hidden');
  for (const link of Array.from(doc.querySelectorAll<HTMLAnchorElement>('[data-language]'))) {
    link.addEventListener('click', () => {
      rememberLanguage(link.dataset['language'] ?? '');
    });
  }
}
