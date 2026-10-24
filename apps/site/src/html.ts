/**
 * HTML built from template literals. Every interpolated value is escaped unless it is already
 * `Html`, so text from the dictionaries or a GitHub release can never become markup.
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type HtmlValue = string | number | Html | null | undefined | false | readonly HtmlValue[];

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

function render(value: HtmlValue): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): Html {
  return new Html(strings.reduce((out, part, i) => out + part + (i < values.length ? render(values[i]) : ''), ''));
}
