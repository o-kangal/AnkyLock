/// <reference types="vite/client" />
// Asset URL imports (`?url`) need Vite's types also where other packages type-check this file.
import fredokaLatin from '@fontsource-variable/fredoka/files/fredoka-latin-wght-normal.woff2?url';
import fredokaLatinExt from '@fontsource-variable/fredoka/files/fredoka-latin-ext-wght-normal.woff2?url';
import monoLatin from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';
import monoLatinExt from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-ext-wght-normal.woff2?url';
import jakartaLatin from '@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2?url';
import jakartaLatinExt from '@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-ext-wght-normal.woff2?url';

/**
 * UI text weight, per theme: light text on a dark background looks heavier, so the dark theme
 * uses a lighter weight (the variable axis allows any value).
 */
export const UI_WEIGHT_VAR = '--al-ui-weight';
export const uiWeight = (scheme: 'light' | 'dark'): number => (scheme === 'dark' ? 450 : 500);

/** Families as Fontsource names them; the stacks in `tokens` and the editor theme use them first. */
export const BRAND_FAMILY = 'Fredoka Variable';
export const UI_FAMILY = 'Plus Jakarta Sans Variable';
export const MONO_FAMILY = 'JetBrains Mono Variable';

// Fontsource's ranges. Turkish ı is in `latin`; ş, ğ and İ are in `latin-ext`.
const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
const LATIN_EXT =
  'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF';

export interface AppFontFace {
  readonly family: string;
  readonly url: string;
  /** The variable font's weight axis. */
  readonly weight: string;
  readonly unicodeRange: string;
}

export const APP_FONT_FACES: readonly AppFontFace[] = [
  { family: BRAND_FAMILY, url: fredokaLatin, weight: '300 700', unicodeRange: LATIN },
  { family: BRAND_FAMILY, url: fredokaLatinExt, weight: '300 700', unicodeRange: LATIN_EXT },
  { family: UI_FAMILY, url: jakartaLatin, weight: '200 800', unicodeRange: LATIN },
  { family: UI_FAMILY, url: jakartaLatinExt, weight: '200 800', unicodeRange: LATIN_EXT },
  { family: MONO_FAMILY, url: monoLatin, weight: '100 800', unicodeRange: LATIN },
  { family: MONO_FAMILY, url: monoLatinExt, weight: '100 800', unicodeRange: LATIN_EXT },
];

let registered = false;

/**
 * Registers the bundled fonts with the `FontFace` API instead of a stylesheet (no global CSS)
 * and starts loading them, so they are ready before the editor opens. The files ship with the
 * app: no CDN, nothing loaded from a third party, and they work offline (the ServiceWorker
 * precaches them). Text shows in the fallback until a font arrives (`display: swap`); CodeMirror
 * re-measures itself once `document.fonts.ready` settles. Runs once; a no-op without `FontFace`.
 */
export function loadAppFonts(fonts: FontFaceSet | undefined = globalThis.document?.fonts): void {
  if (registered || fonts === undefined || typeof FontFace !== 'function') return;
  registered = true;
  for (const face of APP_FONT_FACES) {
    const fontFace = new FontFace(face.family, `url(${face.url}) format('woff2')`, {
      weight: face.weight,
      unicodeRange: face.unicodeRange,
      display: 'swap',
    });
    fonts.add(fontFace);
    // A font that fails to load leaves its fallback in place.
    fontFace.load().catch(() => undefined);
  }
}
