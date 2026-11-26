import { NextResponse, type NextRequest } from 'next/server';

import { completeFederatedSignIn } from '../../../../lib/auth';
import { safeDestination } from '../../../../lib/destination';

/**
 * Where Munaxa Identity (or the organisation's provider) sends the browser back to, and the value
 * of the API's `FEDERATION_REDIRECT_URI` (`<WEB_BASE_URL>/auth/federation/callback`).
 *
 * A provider error, a missing code or a browser that did not start this flow all end on the
 * company sign-in page with one message; which it was is in the API's log, not in the address bar.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const failed = new URL('/login/company?failed=1', request.nextUrl.origin);
  if (params.get('error') !== null) {
    return NextResponse.redirect(failed, 303);
  }
  const outcome = await completeFederatedSignIn({
    code: params.get('code'),
    state: params.get('state'),
  });
  if (!outcome.ok) {
    return NextResponse.redirect(failed, 303);
  }
  return NextResponse.redirect(new URL(safeDestination(outcome.next), request.nextUrl.origin), 303);
}
