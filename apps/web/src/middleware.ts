import { type NextRequest, NextResponse } from 'next/server';

import { ACCESS_TOKEN_COOKIE } from './lib/session';

/**
 * The edge guard.
 *
 * It answers one question — is there a session at all — and defers every other decision to
 * the API. Middleware cannot verify a signature cheaply and must not try: a client-side
 * "permission check" that decides what a user may see is a suggestion, and the server is the
 * only place a permission is decided (`docs/architecture/08-permission-model.md` §1).
 */
const PUBLIC_PATHS = ['/login', '/forgot-password', '/mfa'];

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname.startsWith(path))) {
    return NextResponse.next();
  }

  if (!request.cookies.get(ACCESS_TOKEN_COOKIE)) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    // Where they were going, so signing in resumes it rather than dumping them on a dashboard.
    login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  /*
   * `branding` is excluded for the same reason `_next/static` is: it is a static file, not a
   * screen.
   *
   * Middleware runs for `public/` assets too, so without this the logo on the sign-in card is a
   * request with no session cookie — and the guard above answers it with a redirect to `/login`.
   * The browser gets an HTML document where it asked for a PNG and renders a broken image, on the
   * one screen whose whole job is to say which product you are signing in to. Nothing in the
   * folder is privileged: it is the same artwork the marketing site serves.
   */
  matcher: ['/((?!_next/static|_next/image|branding|favicon.ico|api/health).*)'],
};
