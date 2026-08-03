import 'server-only';

import { cookies } from 'next/headers';

import type { Capabilities } from '@edms/contracts';
import type { PermissionKey } from '@edms/domain';
import { DEFAULT_LOCALE, type LocaleKey, isLocale } from '@edms/i18n';

/**
 * The session, read on the server.
 *
 * The access token never reaches client JavaScript: it is held in an `httpOnly` cookie and
 * attached to API calls by server components and route handlers. A token in `localStorage`
 * is readable by any script that gets injected, which is the failure mode a strict CSP
 * exists to prevent (`docs/architecture/17-security-architecture.md` §2).
 */
export const ACCESS_TOKEN_COOKIE = 'edms_at';
export const REFRESH_TOKEN_COOKIE = 'edms_rt';
export const LOCALE_COOKIE = 'edms_locale';

export interface Session {
  readonly accessToken: string;
  readonly locale: LocaleKey;
}

export async function currentSession(): Promise<Session | null> {
  const store = await cookies();
  const accessToken = store.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) {
    return null;
  }
  return { accessToken, locale: await currentLocale() };
}

export async function currentLocale(): Promise<LocaleKey> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return value && isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * Reads a capability the server computed for a resource.
 *
 * The client never derives permission from a role, a status or a user id. It renders what
 * the server said this caller may do, and nothing else
 * (`docs/architecture/08-permission-model.md` §7).
 */
export function can(capabilities: Capabilities | undefined, permission: PermissionKey): boolean {
  return capabilities?.[permission] === true;
}
