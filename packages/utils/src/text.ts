/** String helpers with no domain meaning. */

const PATH_AND_SHELL_CHARACTERS = /[\\/:*?"<>|]/g;

/** Collapses whitespace and trims. Applied to every free-text field at the boundary. */
export function squish(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Control characters, removed by code point rather than by a regular expression containing
 * literal control characters — which is unreadable in review and unsearchable in a diff.
 */
function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) {
      result += character;
    }
  }
  return result;
}

/**
 * A filename safe to put in `Content-Disposition` and on any filesystem: no path separators,
 * no control characters, no leading dot, bounded length. Downloads are served as attachments
 * with a sanitised name (`docs/architecture/17-security-architecture.md` §5).
 */
export function sanitizeFilename(value: string, maxLength = 200): string {
  const cleaned = stripControlCharacters(value)
    .replace(PATH_AND_SHELL_CHARACTERS, '_')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned.length > 0 ? cleaned : 'download').slice(0, maxLength);
}

/**
 * Unicode formatting characters that reorder what a name *displays* without changing what it is:
 * `invoice\u202Efdp.exe` reads as `invoiceexe.pdf`. Arabic needs none of them to display correctly.
 */
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** RFC 8187 `attr-char`: everything else in an extended value is percent-encoded. */
const NOT_ATTR_CHAR = /[^A-Za-z0-9!#$&+\-.^_`|~]/gu;

/** Combining marks, removed after NFKD so `é` falls back to `e`. */
const COMBINING_MARKS = /\p{M}/gu;

/** Drops unpaired surrogates, which cannot be encoded as UTF-8 and make `encodeURIComponent` throw. */
function wellFormed(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0xd800 || code > 0xdfff) {
      result += character;
    }
  }
  return result;
}

/**
 * The `filename="…"` a client that ignores `filename*` sees: printable ASCII only, with no quote,
 * backslash or percent sign (some clients decode `%xx` there), and `download` keeping the
 * extension when nothing readable is left.
 */
function asciiFallback(name: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^\x20-\x7E]+/gu, '_')
    .replace(/["\\%]/gu, '_')
    .replace(/_+/gu, '_');
  const dot = ascii.lastIndexOf('.');
  const stem = dot > 0 ? ascii.slice(0, dot) : ascii;
  const extension = dot > 0 ? ascii.slice(dot) : '';
  return /[A-Za-z0-9]/u.test(stem)
    ? ascii
    : `download${/^\.[A-Za-z0-9]+$/u.test(extension) ? extension : ''}`;
}

/**
 * A `Content-Disposition` value for a stored file — RFC 6266, with RFC 8187's `filename*` — ADR-0026
 * §10, Phase B preparation.
 *
 * The name is sanitised first (no path, no control characters, so no CR or LF can end the header),
 * with bidirectional overrides removed. A name that is plain ASCII is sent as `filename="…"` alone.
 * Any other name is sent twice: `filename*=UTF-8''…` percent-encoded, which current browsers use,
 * and an ASCII `filename="…"` fallback for clients that do not read `filename*`. Previously the raw
 * UTF-8 went inside the quotes, which no standard defines and clients read as mojibake.
 */
export function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const name = sanitizeFilename(wellFormed(filename).replace(BIDI_CONTROLS, ''));
  const fallback = asciiFallback(name);
  const header = `${kind}; filename="${fallback}"`;
  if (fallback === name) {
    return header;
  }
  const encoded = Array.from(new TextEncoder().encode(name), (byte) =>
    String.fromCharCode(byte),
  ).join('');
  return `${header}; filename*=UTF-8''${encodeExtended(encoded)}`;
}

/** Percent-encodes UTF-8 bytes (one per char of `bytes`) outside `attr-char`. */
function encodeExtended(bytes: string): string {
  return bytes.replace(
    NOT_ATTR_CHAR,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** Case-insensitive comparison for values a human typed: codes, emails, folder names. */
export function equalsIgnoreCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
