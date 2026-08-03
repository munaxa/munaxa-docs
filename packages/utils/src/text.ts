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

/** Case-insensitive comparison for values a human typed: codes, emails, folder names. */
export function equalsIgnoreCase(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
