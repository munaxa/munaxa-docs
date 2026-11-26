/**
 * Where the reader last was in the libraries tree — asked for 26 Nov 2026: leaving Documents for
 * another tab and coming back should land on the same folder, with the same branches open.
 *
 * The page reads the cookie on the server; the rail writes it in the browser.
 */

/**
 * The cookie. Written by the browser rather than by a server action, and so not `httpOnly`: in
 * Next 15 a cookie set from a server action re-renders the current route, which would fetch the
 * whole library page a second time on every folder click. It holds two identifiers the reader can
 * already see in their own address bar, and the page only follows it into a library the caller's
 * own library list contains.
 */
export const LAST_LOCATION_COOKIE = 'edms_docs_location';

/** Thirty days. It is a convenience, not a preference somebody set on purpose. */
export const LAST_LOCATION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LastLocation {
  readonly libraryId: string;
  readonly folderId: string;
}

/** `<libraryId>.<folderId>`, or nothing at all when either half is not an identifier. */
export function formatLastLocation(location: LastLocation): string | null {
  return UUID.test(location.libraryId) && UUID.test(location.folderId)
    ? `${location.libraryId}.${location.folderId}`
    : null;
}

/**
 * The remembered place, or `null` for anything that is not exactly two identifiers.
 *
 * The cookie is input like any other, so it is read as strictly as a query parameter: a value that
 * does not parse is ignored rather than trusted.
 */
export function parseLastLocation(value: string | undefined): LastLocation | null {
  if (value === undefined) return null;
  const [libraryId, folderId, ...rest] = value.split('.');
  if (rest.length > 0 || libraryId === undefined || folderId === undefined) return null;
  if (!UUID.test(libraryId) || !UUID.test(folderId)) return null;
  return { libraryId, folderId };
}

/** Write the cookie from the browser. Best effort: a refused cookie only loses the convenience. */
export function writeLastLocation(location: LastLocation): void {
  const value = formatLastLocation(location);
  if (value === null || typeof document === 'undefined') return;
  try {
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${LAST_LOCATION_COOKIE}=${value}; Path=/; Max-Age=${String(
      LAST_LOCATION_MAX_AGE_SECONDS,
    )}; SameSite=Lax${secure}`;
  } catch {
    // Cookies blocked: nothing to remember, and nothing broken.
  }
}

/** Where the rail keeps the branches the reader opened, per browser. */
export const EXPANDED_STORAGE_KEY = 'edms.docs.rail.expanded';

/** The remembered open branches, or none. Anything that is not a list of strings is ignored. */
export function readExpanded(): readonly string[] {
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').slice(0, 500)
      : [];
  } catch {
    return [];
  }
}

export function writeExpanded(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(ids.slice(0, 500)));
  } catch {
    // Storage blocked or full: the tree still works, it just will not remember.
  }
}
