import { createSignal, For, onCleanup, onMount, type Accessor, type JSX } from 'solid-js';
import { FACE_ORIGIN, FACE_TRANSITIONS, LOCKED_FACES, LOGO, UNLOCKED_FACES, type LogoNode, type Motion, type Paint, type Shape } from '../logo/artwork.js';
import type { LogoFace } from '../runtime/logoFace.js';
import { tokens } from './sidebar/styles.js';

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
 * The AnkyLock padlock-ankylosaurus (artwork in ../logo/artwork.ts). Locking and unlocking spring
 * the shackle open, lift the head and tail and swap the face; with "reduce motion" it switches
 * without moving. Decorative.
 */
export function AnkyLogo(props: AnkyLogoProps): JSX.Element {
  const reducedMotion = createReducedMotion();
  const bg = (): string => props.background ?? tokens.background;
  const paint = (p: Paint | undefined): string | undefined => (p === 'fg' ? tokens.text : p === 'bg' ? bg() : p);
  /** Moving parts, for playing the change into the current state when mounted (`animateIn`). */
  const parts: { el: SVGGElement; frame: (unlocked: boolean) => Keyframe; timing: KeyframeAnimationOptions }[] = [];
  /** A part whose transform (and opacity) depend on the state; changes in place transition. */
  const motion = (
    origin: string,
    frame: (unlocked: boolean) => { readonly transform: string; readonly opacity?: number },
    transition: string,
    timing: KeyframeAnimationOptions,
  ): { ref: (el: SVGGElement) => void; readonly style: JSX.CSSProperties } => ({
    ref: (el) => void parts.push({ el, frame, timing }),
    get style() {
      return { 'transform-origin': origin, ...frame(props.face.unlocked), transition: reducedMotion() ? 'none' : transition };
    },
  });
  const move = (m: Motion) =>
    motion(
      m.origin,
      (unlocked) => ({ transform: unlocked ? m.unlocked : 'none' }),
      `transform ${String(m.duration)}s ${m.easing} ${String(m.delay)}s`,
      { duration: m.duration * 1000, easing: m.easing, delay: m.delay * 1000 },
    );
  const face = (state: 'locked' | 'unlocked') => {
    const { hiddenScale, transition, timing } = FACE_TRANSITIONS[state];
    const shownUnlocked = state === 'unlocked';
    return motion(
      FACE_ORIGIN,
      (unlocked) => (unlocked === shownUnlocked ? { opacity: 1, transform: 'scale(1)' } : { opacity: 0, transform: `scale(${String(hiddenScale)})` }),
      transition,
      timing,
    );
  };
  // A newly inserted element has no earlier style to transition from (WebKit skips it), so a
  // mounting logo plays its keyframes explicitly.
  onMount(() => {
    if (!props.animateIn || reducedMotion()) return;
    const to = props.face.unlocked;
    for (const { el, frame, timing } of parts) {
      if (typeof el.animate === 'function') el.animate([frame(!to), frame(to)], { ...timing, fill: 'backwards' });
    }
  });

  // Paints are read inside the JSX so a new `background` repaints in place.
  const shape = (s: Shape): JSX.Element => {
    switch (s.tag) {
      case 'path':
        return (
          <path
            d={s.d}
            fill={paint(s.fill)}
            stroke={paint(s.stroke)}
            stroke-width={s.strokeWidth}
            stroke-linecap={s.round ? 'round' : undefined}
            stroke-linejoin={s.round || s.roundJoin ? 'round' : undefined}
          />
        );
      case 'circle':
        return <circle cx={s.cx} cy={s.cy} r={s.r} fill={paint(s.fill)} stroke={paint(s.stroke)} stroke-width={s.strokeWidth} />;
      case 'rect':
        return (
          <rect
            x={s.x}
            y={s.y}
            width={s.width}
            height={s.height}
            rx={s.rx}
            fill={paint(s.fill)}
            stroke={paint(s.stroke)}
            stroke-width={s.strokeWidth}
          />
        );
    }
  };
  const node = (n: LogoNode): JSX.Element => {
    switch (n.tag) {
      case 'g':
        return <g {...move(n.motion)}>{n.children.map(node)}</g>;
      case 'face':
        // Both faces stay mounted; the unlocked one is hidden until the first unlock picks it,
        // so the first one fades in too.
        return (
          <g {...face(n.state)}>
            <For each={n.state === 'locked' ? LOCKED_FACES[props.face.locked] : UNLOCKED_FACES[props.face.unlockedFace ?? 'awake']}>
              {(s) => shape(s)}
            </For>
          </g>
        );
      default:
        return shape(n);
    }
  };

  return (
    <svg
      aria-hidden="true"
      data-logo-face={props.face.unlocked ? props.face.unlockedFace ?? '' : props.face.locked}
      width={props.size}
      height={(props.size * 210) / 240}
      viewBox="0 0 240 210"
      style={{ overflow: 'visible', 'flex-shrink': '0' }}
    >
      {LOGO.map(node)}
    </svg>
  );
}
