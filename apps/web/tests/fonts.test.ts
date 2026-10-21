import { afterEach, describe, expect, it, vi } from 'vitest';
import { tokens } from '../src/components/sidebar/styles.js';
import { applyColorScheme } from '../src/theme/colorScheme.js';
import { APP_FONT_FACES, BRAND_FAMILY, MONO_FAMILY, UI_FAMILY, UI_WEIGHT_VAR, loadAppFonts } from '../src/theme/fonts.js';

/** Whether a CSS `unicode-range` list covers a character. */
function covers(range: string, char: string): boolean {
  const code = char.codePointAt(0) ?? -1;
  return range.split(',').some((part) => {
    const [from, to] = part.trim().replace('U+', '').split('-').map((hex) => parseInt(hex, 16));
    return from !== undefined && code >= from && code <= (to ?? from);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('app fonts', () => {
  it('registers every bundled face once, swapping in when loaded', () => {
    const created: { family: string; source: string; descriptors: FontFaceDescriptors }[] = [];
    vi.stubGlobal(
      'FontFace',
      class {
        constructor(family: string, source: string, descriptors: FontFaceDescriptors) {
          created.push({ family, source, descriptors });
        }
        load = (): Promise<void> => Promise.resolve();
      },
    );
    const add = vi.fn();
    loadAppFonts({ add } as unknown as FontFaceSet);
    loadAppFonts({ add } as unknown as FontFaceSet);
    expect(add).toHaveBeenCalledTimes(APP_FONT_FACES.length);
    expect(created.map((f) => f.family)).toEqual([BRAND_FAMILY, BRAND_FAMILY, UI_FAMILY, UI_FAMILY, MONO_FAMILY, MONO_FAMILY]);
    for (const face of created) {
      expect(face.source).toMatch(/^url\(.+\.woff2\) format\('woff2'\)$/);
      // Bundled with the app, never from a CDN.
      expect(face.source).not.toMatch(/https?:/);
      expect(face.descriptors.display).toBe('swap');
    }
    expect(created.map((f) => f.descriptors.weight)).toContain('300 700');
  });

  it('covers Turkish letters with the latin and latin-ext subsets of each family', () => {
    for (const family of [BRAND_FAMILY, UI_FAMILY, MONO_FAMILY]) {
      const ranges = APP_FONT_FACES.filter((f) => f.family === family).map((f) => f.unicodeRange);
      for (const char of 'çğıİöşüÇĞÖŞÜ') expect(ranges.some((r) => covers(r, char))).toBe(true);
    }
  });

  it('uses each stack with system fallbacks, and a lighter UI weight in the dark theme', () => {
    expect(tokens.font).toContain(`13px "${UI_FAMILY}", system-ui`);
    expect(tokens.font).toContain(`var(${UI_WEIGHT_VAR}, 500)`);
    expect(tokens.brandFamily).toMatch(new RegExp(`^"${BRAND_FAMILY}".*sans-serif$`));
    const root = document.createElement('div');
    applyColorScheme('dark', root);
    expect(root.style.getPropertyValue(UI_WEIGHT_VAR)).toBe('450');
    applyColorScheme('light', root);
    expect(root.style.getPropertyValue(UI_WEIGHT_VAR)).toBe('500');
  });
});
