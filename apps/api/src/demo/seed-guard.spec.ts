import { describe, expect, it } from 'vitest';

import { checkDemoSeedEnvironment } from './seed-guard';

const PERMITTED = {
  DEMO_SEED_TENANT: 'munaxa-internal',
  DEMO_SEED_CONFIRM_TENANT: 'munaxa-internal',
  DEMO_SEED_ENVIRONMENT: 'nonprod',
};

describe('the demo seed guard', () => {
  it('permits a non-production environment with the tenant confirmed', () => {
    expect(checkDemoSeedEnvironment(PERMITTED)).toEqual({
      allowed: true,
      slug: 'munaxa-internal',
      dryRun: false,
      problems: [],
    });
  });

  it.each(['development', 'test', 'nonprod', ' NonProd '])('permits %j', (environment) => {
    expect(
      checkDemoSeedEnvironment({ ...PERMITTED, DEMO_SEED_ENVIRONMENT: environment }).allowed,
    ).toBe(true);
  });

  it.each([undefined, '', 'production', 'prod', 'staging'])(
    'refuses environment %j, so production can never be seeded by default',
    (environment) => {
      const result = checkDemoSeedEnvironment({ ...PERMITTED, DEMO_SEED_ENVIRONMENT: environment });
      expect(result.allowed).toBe(false);
      expect(result.problems.join(' ')).toMatch(/never loaded into production/);
    },
  );

  it('refuses when the confirmation names another tenant or is missing', () => {
    expect(
      checkDemoSeedEnvironment({ ...PERMITTED, DEMO_SEED_CONFIRM_TENANT: 'someone-else' }).allowed,
    ).toBe(false);
    expect(
      checkDemoSeedEnvironment({ ...PERMITTED, DEMO_SEED_CONFIRM_TENANT: undefined }).allowed,
    ).toBe(false);
  });

  it('refuses without a tenant', () => {
    const result = checkDemoSeedEnvironment({ ...PERMITTED, DEMO_SEED_TENANT: undefined });
    expect(result.allowed).toBe(false);
  });

  it("falls back to a single-tenant install's own TENANT_SLUG, still needing the confirmation", () => {
    const single = { TENANT_SLUG: 'acme', DEMO_SEED_ENVIRONMENT: 'development' };
    expect(checkDemoSeedEnvironment(single).allowed).toBe(false);
    expect(checkDemoSeedEnvironment({ ...single, DEMO_SEED_CONFIRM_TENANT: 'acme' })).toMatchObject(
      { allowed: true, slug: 'acme' },
    );
  });

  it('reads the dry-run switch strictly', () => {
    expect(checkDemoSeedEnvironment({ ...PERMITTED, DEMO_SEED_DRY_RUN: 'true' }).dryRun).toBe(true);
    expect(checkDemoSeedEnvironment({ ...PERMITTED, DEMO_SEED_DRY_RUN: 'false' }).dryRun).toBe(
      false,
    );
    expect(checkDemoSeedEnvironment({ ...PERMITTED, DEMO_SEED_DRY_RUN: 'yes' }).allowed).toBe(
      false,
    );
  });
});
