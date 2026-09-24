import type { NextFunction, Request, Response } from 'express';

import { type ProxyTrust, clientAddressOf, compileProxyTrust } from '@edms/utils/proxy-trust';

/**
 * Makes `request.ip` the client's address, reading `X-Forwarded-For` only through trusted hops.
 *
 * Express's own `trust proxy` would do the address, and it would also start reading
 * `X-Forwarded-Host` into `request.hostname` — which is how this product picks a tenant from a
 * subdomain. Changing where the tenant comes from is a different decision from changing where the
 * address comes from, so this sets only the address and leaves the host exactly as it was.
 *
 * `request.ip` is what the sign-in rate limit keys on and what a session records. With `TRUST_PROXY`
 * unset it is the socket's address, as before, and a forged header changes nothing. With the web
 * servers or the load balancer named there, it is the browser's — so one busy web server no longer
 * spends a single allowance for every person signing in through it.
 *
 * Registered first, in `configureApp`, so every guard and controller sees the same answer.
 */
export function clientAddressMiddleware(
  trust: ProxyTrust,
): (request: Request, response: Response, next: NextFunction) => void {
  const trusted = compileProxyTrust(trust);
  return (request, _response, next) => {
    const address = clientAddressOf(
      request.socket.remoteAddress,
      request.headers['x-forwarded-for'],
      trusted,
    );
    // An own property shadows the prototype's getter for this request only.
    Object.defineProperty(request, 'ip', { value: address, configurable: true, enumerable: true });
    next();
  };
}
