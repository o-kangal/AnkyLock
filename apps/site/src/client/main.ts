import { animateLogo, FIRST_UNLOCK_MS } from './logo.js';
import { setUpPreferences } from './preferences.js';

setUpPreferences(document);

const logo = document.querySelector<HTMLButtonElement>('[data-logo]');
if (logo) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const set = animateLogo(logo, reducedMotion);
  if (!reducedMotion) setTimeout(() => set(true), FIRST_UNLOCK_MS);
}
