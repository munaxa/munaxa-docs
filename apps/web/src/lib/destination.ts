/**
 * Where the sign-in flow may send somebody afterwards — RC validation, D-19.
 *
 * The one validator for every `next` the login flow honours: the sign-in page, the sign-in action
 * and `/login/session-ended`. It used to be a prefix test written twice — "starts with `/` and not
 * with `//`" — and a prefix test is not what a browser applies to a `Location`. `/\evil.example`
 * passed it, and every browser reads a backslash in a special URL as a slash, so the redirect after
 * signing in landed on `//evil.example`: somebody else's site, from a link that began with ours.
 *
 * So the value is resolved the way the browser will resolve it — the WHATWG URL parser, against a
 * placeholder origin — and kept only if it stays on that origin. That alone is still not enough:
 * dot segments are removed *after* the origin is fixed, so `/.//evil.example` resolves on-origin to
 * the path `//evil.example`, which the browser, handed it as a `Location`, reads as a host. The
 * serialised result is therefore resolved a second time and must come back identical and on-origin.
 * A value that passes is emitted as the parser serialised it, never as the attacker wrote it.
 *
 * Anything else becomes `/`, the product's home — not a repaired version of the input. Stripping
 * characters until a string passes is how the next bypass gets written.
 *
 * Pure and dependency-free, because it runs in a server component, a server action and a route
 * handler alike.
 */
const PLACEHOLDER_ORIGIN = 'http://same-origin.invalid';

export const HOME_DESTINATION = '/';

export function safeDestination(value: unknown): string {
  const requested = Array.isArray(value) ? (value as unknown[])[0] : value;
  if (typeof requested !== 'string' || requested === '') {
    return HOME_DESTINATION;
  }
  const once = onOrigin(requested);
  if (once === null) {
    return HOME_DESTINATION;
  }
  // The browser resolves what we emit, not what we were given: it must mean the same thing again.
  return onOrigin(once) === once ? once : HOME_DESTINATION;
}

/** The path, query and fragment `value` resolves to on this origin, or null if it leaves it. */
function onOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) {
    return null;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  // A path the browser would read as an authority, whatever the parser made of it here.
  return path.startsWith('/') && !path.startsWith('//') ? path : null;
}
