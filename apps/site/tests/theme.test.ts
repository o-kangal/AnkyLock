import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_COLORS } from '../../web/src/theme/colorScheme.js';

// Tests run from the package folder.
const css = readFileSync(join(process.cwd(), 'src/styles/site.css'), 'utf8');

/** `--name: value` pairs of the first rule whose selector starts with `selector`. */
function variables(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return new Map(Array.from(body.matchAll(/--([\w-]+):\s*([^;]+);/g), (m) => [m[1] ?? '', (m[2] ?? '').trim()]));
}

describe('site colors', () => {
  it('match the app’s light and dark palettes', () => {
    const shared = ['background', 'surface', 'text', 'muted', 'border', 'accent'] as const;
    const light = variables(':root');
    const dark = variables(":root[data-theme='dark']");
    const darkBySystem = variables(":root:not([data-theme='light'])");
    for (const name of shared) {
      expect(light.get(name), name).toBe(THEME_COLORS.light[name]);
      expect(dark.get(name), name).toBe(THEME_COLORS.dark[name]);
      expect(darkBySystem.get(name), name).toBe(THEME_COLORS.dark[name]);
    }
    expect(light.get('button-background')).toBe(THEME_COLORS.light.buttonBackground);
    expect(dark.get('button-background')).toBe(THEME_COLORS.dark.buttonBackground);
  });
});
