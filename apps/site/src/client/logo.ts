import { DEFAULT_LOGO_FACE, FACE_ORIGIN, FACE_TRANSITIONS, nextLogoFace, UNLOCKED_EXPRESSIONS, type LogoFace } from '@ankylock/web/logo';
import { MOTIONS } from '../logo.js';

/** How long after the page loads the logo first unlocks, to show it is alive. */
export const FIRST_UNLOCK_MS = 900;

/**
 * Brings the static logo (logo.ts `logoSvg`) to life with the app's own motions: a click
 * locks or unlocks it with a random expression each time. Styles are set through the CSSOM,
 * which the CSP allows (unlike `style` attributes). With "reduce motion" it switches in place.
 */
export function animateLogo(button: HTMLButtonElement, reducedMotion: boolean, random: () => number = Math.random): (unlocked: boolean) => void {
  const svg = button.querySelector('svg');
  if (!svg) return () => undefined;
  const groups = Array.from(svg.querySelectorAll<SVGGElement>('[data-motion]'));
  const faces = { locked: svg.querySelector<SVGGElement>('[data-face="locked"]'), unlocked: svg.querySelector<SVGGElement>('[data-face="unlocked"]') };
  let face: LogoFace = DEFAULT_LOGO_FACE;

  const show = (state: LogoFace): void => {
    groups.forEach((group, i) => {
      const motion = MOTIONS[i];
      if (!motion) return;
      group.style.transformOrigin = motion.origin;
      group.style.transition = reducedMotion ? 'none' : `transform ${String(motion.duration)}s ${motion.easing} ${String(motion.delay)}s`;
      group.style.transform = state.unlocked ? motion.unlocked : 'none';
    });
    for (const which of ['locked', 'unlocked'] as const) {
      const el = faces[which];
      if (!el) continue;
      const shown = state.unlocked === (which === 'unlocked');
      const { hiddenScale, transition } = FACE_TRANSITIONS[which];
      el.removeAttribute('opacity');
      el.style.transformOrigin = FACE_ORIGIN;
      el.style.transition = reducedMotion ? 'none' : transition;
      el.style.opacity = shown ? '1' : '0';
      el.style.transform = shown ? 'scale(1)' : `scale(${String(hiddenScale)})`;
      const expression = which === 'locked' ? state.locked : state.unlockedFace ?? UNLOCKED_EXPRESSIONS[0];
      for (const option of Array.from(el.querySelectorAll<SVGGElement>('[data-expression]'))) {
        // The face that fades out keeps its expression until it is hidden.
        if (shown) option.setAttribute('display', option.dataset['expression'] === expression ? 'inline' : 'none');
      }
    }
    svg.dataset['logoFace'] = state.unlocked ? state.unlockedFace ?? '' : state.locked;
  };

  const set = (unlocked: boolean): void => {
    face = nextLogoFace(face, unlocked, random);
    show(face);
  };
  show(face);
  button.addEventListener('click', () => {
    set(!face.unlocked);
  });
  return set;
}
