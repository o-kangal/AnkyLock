import type { LockedExpression, UnlockedExpression } from '../runtime/logoFace.js';

/**
 * The AnkyLock logo as plain data, drawn from docs/design/logo-expressions.html (viewBox
 * 0 0 240 210), so the app (AnkyLogo.tsx) and the static site (apps/site) draw the same artwork.
 * `fg` strokes and fills the drawing; `bg` fills shapes that hide what is behind them.
 */
export type Paint = 'fg' | 'bg' | 'none';

interface Painted {
  readonly fill: Paint;
  readonly stroke?: Paint;
  readonly strokeWidth?: number;
}

export type Shape =
  | (Painted & { readonly tag: 'path'; readonly d: string; readonly round?: boolean; readonly roundJoin?: boolean })
  | (Painted & { readonly tag: 'circle'; readonly cx: number; readonly cy: number; readonly r: number })
  | (Painted & {
      readonly tag: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly rx: number;
    });

/** How a part moves when the vault unlocks: CSS transform and transition parameters. */
export interface Motion {
  readonly origin: string;
  readonly unlocked: string;
  /** Seconds. */
  readonly duration: number;
  readonly easing: string;
  /** Seconds. */
  readonly delay: number;
}

/** The face slot of the drawing; filled with the current locked or unlocked expression. */
export interface FaceSlot {
  readonly tag: 'face';
  readonly state: 'locked' | 'unlocked';
}

export interface Group {
  readonly tag: 'g';
  readonly motion: Motion;
  readonly children: readonly LogoNode[];
}

export type LogoNode = Shape | Group | FaceSlot;

export const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
export const SMOOTH = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Where a face scales from, and how a face fades in or out (`hiddenScale` when hidden). */
export const FACE_ORIGIN = '56px 145px';
export const FACE_TRANSITIONS: Record<FaceSlot['state'], { readonly hiddenScale: number; readonly transition: string; readonly timing: KeyframeAnimationOptions }> = {
  locked: { hiddenScale: 0.5, transition: `opacity 0.18s ease, transform 0.3s ${SMOOTH}`, timing: { duration: 300, easing: SMOOTH } },
  unlocked: {
    hiddenScale: 0.4,
    transition: `opacity 0.22s ease 0.04s, transform 0.4s ${SPRING} 0.04s`,
    timing: { duration: 400, easing: SPRING, delay: 40 },
  },
};

const line = (d: string, strokeWidth: number): Shape => ({ tag: 'path', d, fill: 'none', stroke: 'fg', strokeWidth, round: true });
const dot = (cx: number, cy: number, r: number): Shape => ({ tag: 'circle', cx, cy, r, fill: 'fg' });
const ring = (cx: number, cy: number, r: number, strokeWidth: number, fill: Paint = 'bg'): Shape => ({
  tag: 'circle',
  cx,
  cy,
  r,
  fill,
  stroke: 'fg',
  strokeWidth,
});
const foot = (x: number): Shape => ({ tag: 'rect', x, y: 162, width: 22, height: 24, rx: 11, fill: 'bg', stroke: 'fg', strokeWidth: 10 });
const move = (origin: string, unlocked: string, duration: number, children: readonly LogoNode[], easing = SPRING, delay = 0): Group => ({
  tag: 'g',
  motion: { origin, unlocked, duration, easing, delay },
  children,
});

export const LOCKED_FACES: Record<LockedExpression, readonly Shape[]> = {
  squint: [line('M 53 138 L 62 143 L 53 148', 5), line('M 43 154 H 49', 4.5)],
  blink: [line('M 52 143 H 64', 5.5), line('M 43 153 Q 47 156 51 153', 4.5)],
  arch: [line('M 52 146 Q 58 138 64 146', 5), line('M 43 153 Q 47 156 51 153', 4.5)],
  sleepz: [line('M 51 142 Q 57 147 63 142 L 66 139', 5), line('M 43 154 H 48', 4), line('M 33 108 H 42 L 33 117 H 42', 4.5)],
  guard: [line('M 50 138 L 65 142', 5.5), dot(58, 144, 3.8), line('M 43 155 Q 47 152 51 155', 4.5)],
  tight: [line('M 53 138 L 63 147 M 63 138 L 53 147', 5), dot(46, 154, 2.8)],
  visor: [{ tag: 'path', d: 'M 47 138 H 68 L 65 147 H 50 Z', fill: 'fg' }, line('M 66 140 H 79', 5), line('M 44 154 Q 49 156 53 152', 4.5)],
  bubble: [line('M 52 143 Q 58 148 64 143', 5), dot(46, 154, 2.5), ring(29, 144, 7.5, 5)],
};

export const UNLOCKED_FACES: Record<UnlockedExpression, readonly Shape[]> = {
  awake: [dot(58, 143, 5), line('M 43 152 Q 48 157 54 152', 4.5)],
  star: [
    { tag: 'path', d: 'M 58 133 L 60.5 139.5 L 67 142 L 60.5 144.5 L 58 151 L 55.5 144.5 L 49 142 L 55.5 139.5 Z', fill: 'fg' },
    { tag: 'path', d: 'M 42 151 Q 48 159 55 151 Z', fill: 'fg' },
  ],
  cheer: [line('M 52 146 C 52 137, 63 137, 63 146', 5), dot(66, 150, 3), line('M 42 151 Q 48 158 54 151', 4.5)],
  curious: [ring(58, 142, 6.5, 4.5), dot(56.5, 142, 2.5), ring(46, 154, 3.5, 4, 'none')],
};

/**
 * The padlock-ankylosaurus. Unlocking springs the shackle open, lifts the head and tail and
 * swaps the face; the whole body bobs.
 */
export const LOGO: readonly LogoNode[] = [
  move('126px 168px', 'translateY(-3px)', 0.45, [
    move('156px 98px', 'translateY(-18px) rotate(15deg)', 0.5, [line('M 96 96 V 58 A 30 30 0 0 1 156 58 V 104', 12)]),
    move('176px 158px', 'rotate(22deg)', 0.55, [line('M 176 158 Q 208 154 206 126', 12), ring(206, 120, 12, 10)]),
    foot(86),
    foot(144),
    move('128px 90px', 'translateY(-2px)', 0.45, [ring(102, 92, 9, 9), ring(128, 86, 10, 9), ring(154, 92, 9, 9)], SPRING, 0.03),
    {
      tag: 'path',
      d: 'M 68 152 C 68 106, 92 90, 126 90 C 160 90, 184 106, 184 152 C 184 166, 174 172, 160 172 H 92 C 78 172, 68 166, 68 152 Z',
      fill: 'bg',
      stroke: 'fg',
      strokeWidth: 11,
      roundJoin: true,
    },
    move('130px 136px', 'rotate(28deg)', 0.45, [dot(130, 128, 9), { tag: 'path', d: 'M 125 132 L 123 152 H 137 L 135 132 Z', fill: 'fg' }]),
    move('72px 148px', 'translate(-4px, -7px) rotate(7deg)', 0.5, [
      { tag: 'path', d: 'M 52 134 L 58 120 L 68 130', fill: 'bg', stroke: 'fg', strokeWidth: 9, round: true },
      { tag: 'rect', x: 34, y: 128, width: 50, height: 40, rx: 20, fill: 'bg', stroke: 'fg', strokeWidth: 10 },
      { tag: 'face', state: 'locked' },
      { tag: 'face', state: 'unlocked' },
    ]),
  ]),
];
