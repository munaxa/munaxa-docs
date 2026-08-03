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
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health).*)'],
};
