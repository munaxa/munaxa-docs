/**
 * What of a watermark's text the stamp can actually carry.
 *
 * The stamp is drawn with a PDF standard font, which encodes WinAnsi and nothing else — so a
 * viewer's identity is transliterated where possible and *substituted* where not: a display
 * name written in Arabic falls back to the account email rather than being dropped, because a
 * mark that names nobody is not a mark (`14-preview-architecture.md` §4). Embedding a
 * shaping-capable Arabic font is the recorded improvement, not this phase's.
 */

export function winAnsiSafe(value: string): string {
  const safe = [...value].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
  });
  const result = safe.join('').replace(/\s+/g, ' ').trim();
  return result.length > 0 ? result : '?';
}

/** Whether enough survives encoding to still identify someone. */
export function isMostlyEncodable(value: string): boolean {
  const survived = winAnsiSafe(value).replace(/[\s?]/g, '');
  const original = value.replace(/\s/g, '');
  return original.length > 0 && survived.length >= Math.ceil(original.length / 2);
}

/** The identity the stamp names: the display name where legible, the fallback otherwise. */
export function stampViewer(displayName: string, fallback: string): string {
  return isMostlyEncodable(displayName) ? displayName : fallback;
}
