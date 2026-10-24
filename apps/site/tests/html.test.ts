import { describe, expect, it } from 'vitest';
import { html } from '../src/html.js';

describe('html', () => {
  it('escapes interpolated text, not nested html', () => {
    const name = '<img src=x onerror="alert(1)">';
    expect(html`<p title="${name}">${name}</p>`.value).toBe(
      '<p title="&lt;img src=x onerror=&quot;alert(1)&quot;&gt;">&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>',
    );
    expect(html`<ul>${['a', 'b'].map((x) => html`<li>${x}</li>`)}</ul>`.value).toBe('<ul><li>a</li><li>b</li></ul>');
  });

  it('drops empty values and keeps numbers', () => {
    expect(html`${null}${undefined}${false}${0}`.value).toBe('0');
  });
});
