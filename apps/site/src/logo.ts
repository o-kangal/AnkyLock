import { LOCKED_EXPRESSIONS, LOCKED_FACES, LOGO, UNLOCKED_EXPRESSIONS, UNLOCKED_FACES, type LogoNode, type Motion, type Paint, type Shape } from '@ankylock/web/logo';
import { html, type Html } from './html.js';

/** The logo's moving groups in document order; `data-motion` on each group is its index here. */
export const MOTIONS: readonly Motion[] = (function collect(nodes: readonly LogoNode[]): Motion[] {
  return nodes.flatMap((n) => (n.tag === 'g' ? [n.motion, ...collect(n.children)] : []));
})(LOGO);

const PAINT: Record<Paint, string> = { fg: 'var(--logo-fg)', bg: 'var(--logo-bg)', none: 'none' };

function shape(s: Shape): Html {
  const paint = html`fill="${PAINT[s.fill]}"${s.stroke ? html` stroke="${PAINT[s.stroke]}"` : ''}${
    s.strokeWidth === undefined ? '' : html` stroke-width="${s.strokeWidth}"`
  }`;
  switch (s.tag) {
    case 'path':
      return html`<path d="${s.d}" ${paint}${s.round ? html` stroke-linecap="round"` : ''}${
        s.round || s.roundJoin ? html` stroke-linejoin="round"` : ''
      }/>`;
    case 'circle':
      return html`<circle cx="${s.cx}" cy="${s.cy}" r="${s.r}" ${paint}/>`;
    case 'rect':
      return html`<rect x="${s.x}" y="${s.y}" width="${s.width}" height="${s.height}" rx="${s.rx}" ${paint}/>`;
  }
}

/**
 * The locked logo's drawing, with every expression present and all but `arch` hidden, so the
 * client script (client/logo.ts) only toggles attributes and styles. Colors are CSS variables.
 */
function drawing(): Html {
  let motion = 0;
  const node = (n: LogoNode): Html => {
    switch (n.tag) {
      case 'g':
        return html`<g data-motion="${motion++}">${n.children.map(node)}</g>`;
      case 'face': {
        const faces =
          n.state === 'locked'
            ? LOCKED_EXPRESSIONS.map((e) => [e, LOCKED_FACES[e]] as const)
            : UNLOCKED_EXPRESSIONS.map((e) => [e, UNLOCKED_FACES[e]] as const);
        const shown = n.state === 'locked' ? 'arch' : 'awake';
        return html`<g data-face="${n.state}"${n.state === 'unlocked' ? html` opacity="0"` : ''}>${faces.map(
          ([name, shapes]) => html`<g data-expression="${name}"${name === shown ? '' : html` display="none"`}>${shapes.map(shape)}</g>`,
        )}</g>`;
      }
      default:
        return shape(n);
    }
  };
  return html`${LOGO.map(node)}`;
}

export const logoSvg = (className: string): Html =>
  html`<svg class="${className}" viewBox="0 0 240 210" aria-hidden="true" focusable="false">${drawing()}</svg>`;

/** The favicon: the locked logo, dark on light or light on dark following the system theme. */
export const faviconSvg = (): string =>
  html`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 0 252 210"><style>svg{--logo-fg:#1f1f1f;--logo-bg:#fff}@media (prefers-color-scheme:dark){svg{--logo-fg:#d4d4d4;--logo-bg:#1e1e1e}}</style>${drawing()}</svg>`
    .value;
