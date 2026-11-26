import type { NextRequest } from 'next/server';

import { abandonFederatedSignIn, completeFederatedSignIn } from '../../../../lib/auth';
import { safeDestination } from '../../../../lib/destination';

/**
 * Where Munaxa Identity (or the organisation's provider) sends the browser back to, and the value
 * of the API's `FEDERATION_REDIRECT_URI` (`<WEB_BASE_URL>/auth/federation/callback`).
 *
 * A provider error, a missing code or a browser that did not start this flow all end on the
 * company sign-in page with one message; which it was is in the API's log, not in the address bar.
 * Redirects are relative (`Location: /path`), so they never depend on the request's Host header.
 */
const seeOther = (path: string): Response =>
  new Response(null, { status: 303, headers: { Location: path, 'Cache-Control': 'no-store' } });

const FAILED = '/login/company?failed=1';

export async function GET(request: NextRequest): Promise<Response> {
  const params = request.nextUrl.searchParams;
  if (params.get('error') !== null) {
    await abandonFederatedSignIn();
    return seeOther(FAILED);
  }
  const outcome = await completeFederatedSignIn({
    code: params.get('code'),
    state: params.get('state'),
  });
  return seeOther(outcome.ok ? safeDestination(outcome.next) : FAILED);
}
