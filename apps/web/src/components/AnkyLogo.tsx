import { createSignal, onCleanup, onMount, type Accessor, type JSX } from 'solid-js';
import type { LockedExpression, LogoFace, UnlockedExpression } from '../runtime/logoFace.js';
import { tokens } from './sidebar/styles.js';

const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
const SMOOTH = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** How long a lock or unlock takes to play: the longest transition (the tail) plus a margin. */
export const LOGO_TRANSITION_MS = 650;

/** Follows the OS "reduce motion" setting; without `matchMedia` (tests) motion stays on. */
export function createReducedMotion(): Accessor<boolean> {
  if (typeof matchMedia !== 'function') return () => false;
  const query = matchMedia('(prefers-reduced-motion: reduce)');
  const [reduced, setReduced] = createSignal(query.matches);
  const onChange = (event: MediaQueryListEvent): void => {
    setReduced(event.matches);
  };
  query.addEventListener('change', onChange);
  onCleanup(() => query.removeEventListener('change', onChange));
  return reduced;
}

/** Strokes and fills of one face; `fg` draws, `bg` fills shapes that hide what is behind. */
type Face = (fg: string, bg: string) => JSX.Element;

const line = (d: string, fg: string, width: number): JSX.Element => (
  <path d={d} fill="none" stroke={fg} stroke-width={width} stroke-linecap="round" stroke-linejoin="round" />
);

// Drawn from docs/design/logo-expressions.html (viewBox 0 0 240 210).
const LOCKED_FACES: Record<LockedExpression, Face> = {
  squint: (fg) => [line('M 53 138 L 62 143 L 53 148', fg, 5), line('M 43 154 H 49', fg, 4.5)],
  blink: (fg) => [line('M 52 143 H 64', fg, 5.5), line('M 43 153 Q 47 156 51 153', fg, 4.5)],
  arch: (fg) => [line('M 52 146 Q 58 138 64 146', fg, 5), line('M 43 153 Q 47 156 51 153', fg, 4.5)],
  sleepz: (fg) => [
    line('M 51 142 Q 57 147 63 142 L 66 139', fg, 5),
    line('M 43 154 H 48', fg, 4),
    line('M 33 108 H 42 L 33 117 H 42', fg, 4.5),
  ],
  guard: (fg) => [
    line('M 50 138 L 65 142', fg, 5.5),
    <circle cx="58" cy="144" r="3.8" fill={fg} />,
    line('M 43 155 Q 47 152 51 155', fg, 4.5),
  ],
  tight: (fg) => [line('M 53 138 L 63 147 M 63 138 L 53 147', fg, 5), <circle cx="46" cy="154" r="2.8" fill={fg} />],
  visor: (fg) => [
    <path d="M 47 138 H 68 L 65 147 H 50 Z" fill={fg} />,
    line('M 66 140 H 79', fg, 5),
    line('M 44 154 Q 49 156 53 152', fg, 4.5),
  ],
  bubble: (fg, bg) => [
    line('M 52 143 Q 58 148 64 143', fg, 5),
    <circle cx="46" cy="154" r="2.5" fill={fg} />,
    <circle cx="29" cy="144" r="7.5" fill={bg} stroke={fg} stroke-width="5" />,
  ],
};

const UNLOCKED_FACES: Record<UnlockedExpression, Face> = {
  awake: (fg) => [<circle cx="58" cy="143" r="5" fill={fg} />, line('M 43 152 Q 48 157 54 152', fg, 4.5)],
  star: (fg) => [
    <path d="M 58 133 L 60.5 139.5 L 67 142 L 60.5 144.5 L 58 151 L 55.5 144.5 L 49 142 L 55.5 139.5 Z" fill={fg} />,
    <path d="M 42 151 Q 48 159 55 151 Z" fill={fg} />,
  ],
  cheer: (fg) => [
    line('M 52 146 C 52 137, 63 137, 63 146', fg, 5),
    <circle cx="66" cy="150" r="3" fill={fg} />,
    line('M 42 151 Q 48 158 54 151', fg, 4.5),
  ],
  curious: (fg, bg) => [
    <circle cx="58" cy="142" r="6.5" fill={bg} stroke={fg} stroke-width="4.5" />,
    <circle cx="56.5" cy="142" r="2.5" fill={fg} />,
    <circle cx="46" cy="154" r="3.5" fill="none" stroke={fg} stroke-width="4" />,
  ],
};

export interface AnkyLogoProps {
  readonly face: LogoFace;
  /** Width in px; the height follows the 240:210 artwork. */
  readonly size: number;
  /** The color behind the logo, which fills its shapes (default: the page background). */
  readonly background?: string;
  /** Plays the change into the current state once mounted, for a logo that appears with a lock. */
  readonly animateIn?: boolean;
}

/**
 * The AnkyLock padlock-ankylosaurus. Locking and unlocking spring the shackle open, lift the
 * head and tail and swap the face; with "reduce motion" it switches without moving. Decorative.
 */
export function AnkyLogo(props: AnkyLogoProps): JSX.Element {
  const reducedMotion = createReducedMotion();
  let svg: SVGSVGElement | undefined;
  const [entered, setEntered] = createSignal(!props.animateIn);
  if (props.animateIn) {
    let frame = 0;
    onMount(() => {
      // Commits the starting state first, so the browser has something to transition from.
      if (svg) void getComputedStyle(svg).transform;
      frame = requestAnimationFrame(() => setEntered(true));
    });
    onCleanup(() => cancelAnimationFrame(frame));
  }
  const unlocked = (): boolean => (entered() ? props.face.unlocked : !props.face.unlocked);
  const fg = tokens.text;
  const bg = (): string => props.background ?? tokens.background;
  /** A part that moves from `locked` to `unlocked` around `origin` (user units). */
  const part = (origin: string, unlockedTransform: string, duration: number, easing = SPRING, delay = 0): JSX.CSSProperties => ({
    'transform-origin': origin,
    transform: unlocked() ? unlockedTransform : 'none',
    transition: reducedMotion() ? 'none' : `transform ${duration}s ${easing} ${delay}s`,
  });
  const faceStyle = (visible: boolean, hiddenScale: number, transition: string): JSX.CSSProperties => ({
    'transform-origin': '56px 145px',
    opacity: visible ? 1 : 0,
    transform: visible ? 'scale(1)' : `scale(${hiddenScale})`,
    transition: reducedMotion() ? 'none' : transition,
  });

  return (
    <svg
      ref={svg}
      aria-hidden="true"
      data-logo-face={props.face.unlocked ? props.face.unlockedFace ?? '' : props.face.locked}
      width={props.size}
      height={(props.size * 210) / 240}
      viewBox="0 0 240 210"
      style={{ overflow: 'visible', 'flex-shrink': '0' }}
    >
      <g style={part('126px 168px', 'translateY(-3px)', 0.45)}>
        <g style={part('156px 98px', 'translateY(-18px) rotate(15deg)', 0.5)}>
          {line('M 96 96 V 58 A 30 30 0 0 1 156 58 V 104', fg, 12)}
        </g>
        <g style={part('176px 158px', 'rotate(22deg)', 0.55)}>
          {line('M 176 158 Q 208 154 206 126', fg, 12)}
          <circle cx="206" cy="120" r="12" fill={bg()} stroke={fg} stroke-width="10" />
        </g>
        <rect x="86" y="162" width="22" height="24" rx="11" fill={bg()} stroke={fg} stroke-width="10" />
        <rect x="144" y="162" width="22" height="24" rx="11" fill={bg()} stroke={fg} stroke-width="10" />
        <g style={part('128px 90px', 'translateY(-2px)', 0.45, SPRING, 0.03)}>
          <circle cx="102" cy="92" r="9" fill={bg()} stroke={fg} stroke-width="9" />
          <circle cx="128" cy="86" r="10" fill={bg()} stroke={fg} stroke-width="9" />
          <circle cx="154" cy="92" r="9" fill={bg()} stroke={fg} stroke-width="9" />
        </g>
        <path
          d="M 68 152 C 68 106, 92 90, 126 90 C 160 90, 184 106, 184 152 C 184 166, 174 172, 160 172 H 92 C 78 172, 68 166, 68 152 Z"
          fill={bg()}
          stroke={fg}
          stroke-width="11"
          stroke-linejoin="round"
        />
        <g style={part('130px 136px', 'rotate(28deg)', 0.45)}>
          <circle cx="130" cy="128" r="9" fill={fg} />
          <path d="M 125 132 L 123 152 H 137 L 135 132 Z" fill={fg} />
        </g>
        <g style={part('72px 148px', 'translate(-4px, -7px) rotate(7deg)', 0.5)}>
          <path
            d="M 52 134 L 58 120 L 68 130"
            fill={bg()}
            stroke={fg}
            stroke-width="9"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <rect x="34" y="128" width="50" height="40" rx="20" fill={bg()} stroke={fg} stroke-width="10" />
          <g style={faceStyle(!unlocked(), 0.5, `opacity 0.18s ease, transform 0.3s ${SMOOTH}`)}>
            {LOCKED_FACES[props.face.locked](fg, bg())}
          </g>
          {/* Hidden until the first unlock picks a face; kept mounted so the first one fades in too. */}
          <g style={faceStyle(unlocked(), 0.4, `opacity 0.22s ease 0.04s, transform 0.4s ${SPRING} 0.04s`)}>
            {UNLOCKED_FACES[props.face.unlockedFace ?? 'awake'](fg, bg())}
          </g>
        </g>
      </g>
    </svg>
  );
}
