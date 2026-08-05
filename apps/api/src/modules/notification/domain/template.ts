/**
 * The template language: placeholder substitution, and nothing else.
 *
 * Deliberately not a template *engine*. No conditionals, no loops, no expressions, no property
 * access — `{{ documentNumber }}` and that is the whole grammar
 * (`docs/architecture/18-notification-architecture.md` §6).
 *
 * The reason is that templates are tenant-editable data. An engine that evaluates expressions
 * turns "an administrator edited the approval email" into server-side code execution, and
 * every general-purpose engine has had that CVE. A substituting renderer cannot: the worst a
 * malicious template can do is say something untrue, which is what review is for.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export type RenderFailure =
  | { readonly reason: 'MISSING_VALUE'; readonly variable: string }
  | { readonly reason: 'UNDECLARED_VARIABLE'; readonly variable: string };

export interface RenderResult {
  readonly text: string;
  readonly failures: readonly RenderFailure[];
}

/**
 * Escapes text for an HTML body.
 *
 * Values are escaped, always, and the template's own markup is not — that is the split that
 * makes a document title containing `<script>` harmless while still allowing an HTML email.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Substitutes `{{ name }}` placeholders.
 *
 * A missing value is reported rather than rendered as an empty string. A notification reading
 * "Document  was approved by " is worse than one that failed loudly: it reaches a person, it
 * looks like a product defect, and nobody can tell which value was lost.
 *
 * `declared` is the type's variable list. A placeholder outside it is reported too — that is
 * how a template edited to reference `{{ password }}` gets caught rather than quietly
 * rendering nothing.
 */
export function render(
  template: string,
  values: Readonly<Record<string, string>>,
  declared: readonly string[],
  options: { readonly escape: boolean },
): RenderResult {
  const failures: RenderFailure[] = [];

  const text = template.replace(PLACEHOLDER, (_match, rawName: string) => {
    const name = rawName;
    if (!declared.includes(name)) {
      failures.push({ reason: 'UNDECLARED_VARIABLE', variable: name });
      return '';
    }
    const value = values[name];
    if (value === undefined) {
      failures.push({ reason: 'MISSING_VALUE', variable: name });
      return '';
    }
    // Escaped *first*, then its line breaks turned into markup. The order is the whole of the
    // safety property: a value containing `<br>` is escaped to `&lt;br&gt;` and stays text, while
    // a value that genuinely spans lines — a digest's list of items — keeps its shape in an HTML
    // body instead of collapsing into one run-on sentence. This is a rendering rule about
    // *whitespace*, not a way for a value to introduce markup.
    return options.escape ? escapeHtml(value).replaceAll('\n', '<br>') : value;
  });

  return { text, failures };
}

/** A rendered message, ready for an adapter to deliver. */
export interface RenderedMessage {
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string | null;
}

export interface MessageTemplate {
  readonly subject: string;
  readonly bodyText: string;
  /** Null for channels that have no HTML — in-app, SMS. */
  readonly bodyHtml: string | null;
}

/**
 * Renders a whole message, or reports every problem at once.
 *
 * All three parts are attempted even when the first fails, so an administrator fixing a
 * template is told everything wrong with it rather than discovering the faults one send at a
 * time.
 */
export function renderMessage(
  template: MessageTemplate,
  values: Readonly<Record<string, string>>,
  declared: readonly string[],
): { readonly message: RenderedMessage | null; readonly failures: readonly RenderFailure[] } {
  // The subject and the plain-text body are not HTML, so escaping them would put `&amp;` in
  // front of a person. Only the HTML body is escaped.
  const subject = render(template.subject, values, declared, { escape: false });
  const bodyText = render(template.bodyText, values, declared, { escape: false });
  const bodyHtml = template.bodyHtml
    ? render(template.bodyHtml, values, declared, { escape: true })
    : null;

  const failures = [...subject.failures, ...bodyText.failures, ...(bodyHtml?.failures ?? [])];
  if (failures.length > 0) {
    return { message: null, failures };
  }

  return {
    message: {
      subject: subject.text,
      bodyText: bodyText.text,
      bodyHtml: bodyHtml ? bodyHtml.text : null,
    },
    failures: [],
  };
}
