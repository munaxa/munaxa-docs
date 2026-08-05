import { describe, expect, it } from 'vitest';

import {
  API_KEY_PREFIX_LENGTH,
  ApiScope,
  DEFAULT_CLAIM_MAPPING,
  WEBHOOK_SIGNATURE_VERSION,
  domainMatches,
  effectiveApiPermissions,
  isApiScope,
  parseApiKey,
  permissionsForScopes,
  rolesForClaims,
  sinkCarries,
  webhookBackoffMs,
  webhookSignatureHeader,
  webhookSigningString,
  webhookSubscribes,
} from './integration';

describe('api scopes', () => {
  it('narrows and never widens', () => {
    // The subject holds far more than the scope admits; the scope is the ceiling.
    const held = ['document:view', 'document:edit', 'user:manage', 'settings:manage'];
    expect(effectiveApiPermissions(held, [ApiScope.DOCUMENTS_READ])).toEqual(['document:view']);
  });

  it('cannot grant what the subject does not hold', () => {
    // The clearest statement of the direction: a client scoped to write, whose subject may only
    // read, writes nothing. A union would have produced `document:edit` here.
    expect(effectiveApiPermissions(['document:view'], [ApiScope.DOCUMENTS_WRITE])).toEqual([
      'document:view',
    ]);
  });

  it('admits nothing for an empty scope list', () => {
    expect(effectiveApiPermissions(['document:view'], [])).toEqual([]);
  });

  it('never admits document:sign under any scope', () => {
    // Part 11 §11.200: a signature is executed by a person with two components they alone
    // control. A key in a script is neither, and no configuration may make it one.
    const everything = permissionsForScopes(Object.values(ApiScope));
    expect(everything).not.toContain('document:sign');
    expect(everything).not.toContain('user:manage');
    expect(everything).not.toContain('role:manage');
    expect(everything).not.toContain('settings:manage');
  });

  it('ignores a scope string it does not know', () => {
    expect(isApiScope('documents:everything')).toBe(false);
    expect(effectiveApiPermissions(['document:view'], ['documents:everything'])).toEqual([]);
  });
});

describe('api keys', () => {
  const prefix = 'a'.repeat(API_KEY_PREFIX_LENGTH);
  const secret = 'b'.repeat(43);

  it('parses one of ours', () => {
    expect(parseApiKey(`mdk.${prefix}.${secret}`)).toEqual({ prefix, secret });
  });

  it('parses a key whose segments contain base64url punctuation', () => {
    // **The regression the Phase 17 integration suite found.** Both segments are `base64url`,
    // whose alphabet includes `-` and `_`, so a key separated by `_` split into an unpredictable
    // number of parts for roughly one key in three — and was refused as malformed. `.` is outside
    // the alphabet, so this is unambiguous by construction rather than by luck.
    const awkward = 'lMD0EkQf8gaB36bq017_jQk9DU44KZkgrXICT1W_gxQ';
    const punctuated = '167ott-XZ_cY';
    expect(parseApiKey(`mdk.${punctuated}.${awkward}`)).toEqual({
      prefix: punctuated,
      secret: awkward,
    });
  });

  it('refuses anything else without throwing', () => {
    // A JWT has three dot-separated parts too, which is why the scheme prefix is checked first.
    expect(parseApiKey('eyJhbGciOiJIUzI1NiJ9.e30.x')).toBeNull();
    expect(parseApiKey(`mdk.${prefix}.short`)).toBeNull();
    expect(parseApiKey(`other.${prefix}.${secret}`)).toBeNull();
    expect(parseApiKey('')).toBeNull();
  });
});

describe('webhook signing', () => {
  it('puts the timestamp inside the signed string', () => {
    // The property that makes a replay window enforceable: a signature over the body alone stays
    // valid forever, so the timestamp has to be covered by the digest rather than beside it.
    expect(webhookSigningString(1_700_000_000, '{"a":1}')).toBe('v1:1700000000:{"a":1}');
    expect(webhookSigningString(1_700_000_001, '{"a":1}')).not.toBe(
      webhookSigningString(1_700_000_000, '{"a":1}'),
    );
  });

  it('presents the version in the value', () => {
    expect(webhookSignatureHeader('deadbeef')).toBe(`${WEBHOOK_SIGNATURE_VERSION}=deadbeef`);
  });
});

describe('webhook subscriptions', () => {
  it('treats an empty list as every event', () => {
    expect(webhookSubscribes([], 'document.published')).toBe(true);
    expect(webhookSubscribes([], 'anything.at.all')).toBe(true);
  });

  it('matches on a prefix boundary rather than a substring', () => {
    expect(webhookSubscribes(['document'], 'document.published')).toBe(true);
    expect(webhookSubscribes(['document'], 'documentation.written')).toBe(false);
    expect(webhookSubscribes(['document.published'], 'document.published')).toBe(true);
    expect(webhookSubscribes(['document.published'], 'document.created')).toBe(false);
  });
});

describe('webhook backoff', () => {
  it('never returns less than half the base, and is capped', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const low = webhookBackoffMs(attempt, 0);
      const high = webhookBackoffMs(attempt, 0.999999);
      expect(low).toBeGreaterThanOrEqual(2_500);
      expect(high).toBeLessThanOrEqual(3_600_000);
      expect(high).toBeGreaterThanOrEqual(low);
    }
  });

  it('spreads deliveries that would otherwise synchronise', () => {
    // Two deliveries failing at the same instant on the same attempt must not come back together.
    expect(webhookBackoffMs(3, 0)).not.toBe(webhookBackoffMs(3, 0.9));
  });
});

describe('federation', () => {
  it('maps asserted groups to pre-mapped roles and nothing else', () => {
    const roles = rolesForClaims(
      ['grp-approvers', 'grp-unknown'],
      [
        { claimValue: 'grp-approvers', roleKey: 'APPROVER' },
        { claimValue: 'grp-admins', roleKey: 'TENANT_ADMIN' },
      ],
      ['READER'],
    );
    // The unmapped group contributes nothing, and the unasserted mapping grants nothing.
    expect([...roles].sort()).toEqual(['APPROVER', 'READER']);
  });

  it('provisions to the defaults alone when nothing matches', () => {
    expect(rolesForClaims([], [{ claimValue: 'g', roleKey: 'TENANT_ADMIN' }], ['READER'])).toEqual([
      'READER',
    ]);
  });

  it('matches a domain on a label boundary', () => {
    expect(domainMatches('ada@acme.com', ['acme.com'])).toBe(true);
    expect(domainMatches('ada@eng.acme.com', ['acme.com'])).toBe(true);
    // The one that matters: a lookalike domain must not select somebody else's provider.
    expect(domainMatches('ada@evil-acme.com', ['acme.com'])).toBe(false);
    expect(domainMatches('ada@acme.com.evil.net', ['acme.com'])).toBe(false);
    expect(domainMatches('not-an-address', ['acme.com'])).toBe(false);
  });

  it('accepts a domain written with a leading @ or in mixed case', () => {
    expect(domainMatches('Ada@ACME.com', ['@Acme.COM'])).toBe(true);
  });

  it('defaults to the claim names most providers use', () => {
    expect(DEFAULT_CLAIM_MAPPING.subject).toBe('sub');
    expect(DEFAULT_CLAIM_MAPPING.email).toBe('email');
  });
});

describe('audit sinks', () => {
  it('carries everything when no action is named', () => {
    expect(sinkCarries([], 'DOCUMENT_VIEWED')).toBe(true);
  });

  it('carries only the named actions otherwise', () => {
    expect(sinkCarries(['LOGIN_FAILED'], 'LOGIN_FAILED')).toBe(true);
    expect(sinkCarries(['LOGIN_FAILED'], 'DOCUMENT_VIEWED')).toBe(false);
  });
});
