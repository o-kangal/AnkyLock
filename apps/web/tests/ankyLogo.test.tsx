import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnkyLockApp } from '../src/components/AnkyLockApp.jsx';
import { AnkyLogo, LOGO_TRANSITION_MS } from '../src/components/AnkyLogo.jsx';
import { createRuntime } from '../src/index.js';
import {
  DEFAULT_LOGO_FACE,
  LOCKED_EXPRESSIONS,
  UNLOCKED_EXPRESSIONS,
  nextLogoFace,
  pickExpression,
  type LogoFace,
} from '../src/runtime/logoFace.js';
import { PASSPHRASE, TestVaults, localSealer, until } from './helpers.js';

/** Cycles through fixed numbers in [0, 1), standing in for Math.random. */
const sequence = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++ % values.length] ?? 0;
};

const disposers: (() => void)[] = [];
afterEach(() => {
  while (disposers.length) disposers.pop()?.();
  vi.unstubAllGlobals();
});

function mount(face: () => LogoFace, animateIn = false): SVGSVGElement {
  const root = document.createElement('div');
  document.body.append(root);
  const dispose = render(() => <AnkyLogo face={face()} size={96} animateIn={animateIn} />, root);
  disposers.push(() => {
    dispose();
    root.remove();
  });
  return root.querySelector('svg') as SVGSVGElement;
}

/** The shackle's group: it lifts when unlocked. */
const shackle = (svg: SVGSVGElement): SVGGElement => svg.querySelectorAll('g')[1] as SVGGElement;

describe('logo expressions', () => {
  it('picks within the set and never the previous one', () => {
    for (const r of [0, 0.3, 0.6, 0.999]) {
      const picked = pickExpression(LOCKED_EXPRESSIONS, 'arch', () => r);
      expect(LOCKED_EXPRESSIONS).toContain(picked);
      expect(picked).not.toBe('arch');
    }
    expect(pickExpression(UNLOCKED_EXPRESSIONS, null, () => 0.999)).toBe('curious');
  });

  it('starts on "arch", changes the face only when the state changes', () => {
    expect(DEFAULT_LOGO_FACE).toEqual({ unlocked: false, locked: 'arch', unlockedFace: null });
    const random = sequence(0, 0.5);
    const open = nextLogoFace(DEFAULT_LOGO_FACE, true, random);
    expect(open).toEqual({ unlocked: true, locked: 'arch', unlockedFace: 'awake' });
    expect(nextLogoFace(open, true, random)).toBe(open);
    const closed = nextLogoFace(open, false, random);
    expect(closed.unlocked).toBe(false);
    expect(closed.locked).not.toBe('arch');
    expect(nextLogoFace(closed, true, () => 0).unlockedFace).not.toBe('awake');
  });

  it('follows the runtime: a new face on every unlock and lock', async () => {
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer(), random: sequence(0.1, 0.7, 0.4) });
    await runtime.init();
    expect(runtime.logoFace()).toEqual(DEFAULT_LOGO_FACE);
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    const unlocked = runtime.logoFace();
    expect(unlocked.unlocked).toBe(true);
    expect(UNLOCKED_EXPRESSIONS).toContain(unlocked.unlockedFace);
    await runtime.lock();
    const locked = runtime.logoFace();
    expect(locked.unlocked).toBe(false);
    expect(LOCKED_EXPRESSIONS).toContain(locked.locked);
    expect(locked.locked).not.toBe('arch');
    const id = runtime.vaults()[0]?.id;
    expect(id && (await runtime.unlock(id, PASSPHRASE))).toBeNull();
    expect(runtime.logoFace().unlockedFace).not.toBe(unlocked.unlockedFace);
    await runtime.lock();
  });
});

describe('AnkyLogo', () => {
  it('is decorative, shows the current face and springs the shackle open on unlock', () => {
    const [face, setFace] = createSignal<LogoFace>(DEFAULT_LOGO_FACE);
    const svg = mount(face);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('height')).toBe('84');
    expect(svg.getAttribute('data-logo-face')).toBe('arch');
    expect(shackle(svg).style.transform).toBe('none');
    expect(shackle(svg).style.transition).toContain('transform 0.5s');

    setFace({ unlocked: true, locked: 'arch', unlockedFace: 'star' });
    expect(svg.getAttribute('data-logo-face')).toBe('star');
    expect(shackle(svg).style.transform).toBe('translateY(-18px) rotate(15deg)');
  });

  it('switches without motion when the OS asks to reduce motion', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const svg = mount(() => DEFAULT_LOGO_FACE);
    expect(shackle(svg).style.transition).toBe('none');
  });

  it('plays the change into its state after mounting', async () => {
    const svg = mount(() => ({ unlocked: true, locked: 'arch', unlockedFace: 'cheer' }), true);
    expect(shackle(svg).style.transform).toBe('none');
    await vi.waitFor(() => expect(shackle(svg).style.transform).toBe('translateY(-18px) rotate(15deg)'));
  });
});

describe('lock and unlock on screen', () => {
  function app(): { root: HTMLElement; runtime: ReturnType<typeof createRuntime> } {
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer() });
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = render(() => <AnkyLockApp runtime={runtime} narrow={() => false} />, root);
    disposers.push(() => {
      dispose();
      root.remove();
    });
    return { root, runtime };
  }
  const pickerLogo = (root: HTMLElement): SVGSVGElement | null => root.querySelector('main svg[aria-hidden="true"]');

  it('plays the unlock on the picker before opening the vault, and the lock when it comes back', async () => {
    const { root, runtime } = app();
    await until(() => runtime.status() === 'uninitialized', 'picker');
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    const opened = Date.now();
    // Still the picker, its logo springing open.
    expect(pickerLogo(root)?.getAttribute('data-logo-face')).toBe(runtime.logoFace().unlockedFace);
    expect(root.querySelector('aside')).toBeNull();
    await until(() => root.querySelector('aside') !== null, 'workspace');
    expect(Date.now() - opened).toBeGreaterThanOrEqual(LOGO_TRANSITION_MS - 50);

    await runtime.lock();
    const logo = pickerLogo(root) as SVGSVGElement;
    expect(logo.getAttribute('data-logo-face')).toBe(runtime.logoFace().locked);
    // Starts open, then closes.
    expect(shackle(logo).style.transform).not.toBe('none');
    await until(() => shackle(logo).style.transform === 'none', 'locked');
  });

  it('opens the vault right away when the OS asks to reduce motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    const { root, runtime } = app();
    await until(() => runtime.status() === 'uninitialized', 'picker');
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    await Promise.resolve();
    expect(root.querySelector('aside')).not.toBeNull();
    await runtime.lock();
  });
});
