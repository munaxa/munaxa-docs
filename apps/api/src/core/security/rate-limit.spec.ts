import { describe, expect, it } from 'vitest';

import { ruleFor, ruleForRequest } from './rate-limit';

/**
 * Following a verified download link is throttled by address — the security review's D-1.
 *
 * The route is public, so the identity-keyed default never applied to it, and each use re-runs
 * its redeemer's database checks.
 */
describe('the download redemption rate limit', () => {
  it('applies to GET /api/v1/downloads, keyed by address', () => {
    const route = ruleForRequest('GET', '/api/v1/downloads');
    expect(route.rule).toBe('download.redeem');
    expect(ruleFor(route.rule)).toMatchObject({ windowSeconds: 60, limit: 240, by: ['ip'] });
  });

  it('leaves other routes as they were', () => {
    expect(ruleForRequest('GET', '/api/v1/documents').rule).toBe('default');
    expect(ruleForRequest('POST', '/api/v1/downloads').rule).toBe('default');
  });
});
