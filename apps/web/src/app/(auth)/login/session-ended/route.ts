import { type NextRequest, NextResponse } from 'next/server';

import { safeDestination } from '../../../../lib/destination';
import { checkSession } from '../../../../lib/session-check';
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, TENANT_COOKIE } from '../../../../lib/session';

/**
 * Where a refused session is cleared — RC validation, D-18.
 *
 * A page that learns from the API that its session was refused cannot remove the cookie itself: a
 * server component may read cookies but not write them. Before this route existed it redirected to
 * `/login` with the cookie still in place, and the login page, seeing a cookie, redirected back — the
 * loop D-18 measured.
 *
 * It is a `GET` because it is reached by a redirect, and that would ordinarily make it a forced-logout
 * endpoint: any page could embed an image pointing here. It is not one, because it decides nothing on
 * the caller's say-so. It asks the API again and clears the cookies **only** on the API's own
 * `UNAUTHENTICATED` — a verdict that the session is already over, which no third party can bring
 * about by linking here. A valid session is sent on unchanged; an API that did not answer leaves the
 * cookie where it is and the sign-in screen says so.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const next = safeDestination(request.nextUrl.searchParams.get('next'));
  const token = request.cookies.get(ACCESS_TOKEN_COOKIE)?.value;

  if (!token) {
    return seeOther(loginPath(next, false));
  }

  const check = await checkSession(token);
  if (check.state === 'VALID') {
    return seeOther(next);
  }
  if (check.state === 'UNAVAILABLE') {
    // Kept: nobody knows the session is over. The login page makes the same check and, getting the
    // same non-answer, renders the form with a notice instead of sending anybody anywhere.
    return seeOther(loginPath(next, false));
  }

  const response = seeOther(loginPath(next, true));
  // The attributes `storeSession` set them with, because a cookie is only replaced by one with the
  // same name, path and domain.
  for (const name of [ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE, TENANT_COOKIE]) {
    response.cookies.set(name, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: new Date(0),
    });
  }
  return response;
}

/**
 * A relative `303`, so a browser behind any proxy stays on the origin it asked, and nothing about
 * which session this was is cached on the way.
 */
function seeOther(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store' },
  });
}

function loginPath(next: string, ended: boolean): string {
  const query = new URLSearchParams();
  if (next !== '/') {
    query.set('next', next);
  }
  if (ended) {
    query.set('ended', '1');
  }
  const search = query.toString();
  return search ? `/login?${search}` : '/login';
}
