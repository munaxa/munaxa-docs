/**
 * Whether the demo starter configuration may be loaded, decided from the environment alone.
 *
 * Demo data in a production tenant is a real problem — invented document types offered to real
 * authors, an approval group nobody chose — so the command does nothing unless the operator says,
 * explicitly and for this run, both **which** tenant and **that it is not production**:
 *
 * - `DEMO_SEED_ENVIRONMENT` must name a non-production environment (`development`, `test` or
 *   `nonprod`). There is no default, and `production` (or anything else) is refused. Nothing in the
 *   deployment sets it: it exists only on the one-off run an operator starts on purpose.
 * - `DEMO_SEED_TENANT` names the tenant, and `DEMO_SEED_CONFIRM_TENANT` must repeat it exactly, so
 *   a command pointed at the wrong tenant by a copied environment refuses rather than writes.
 *
 * The tenant has its own variable rather than reusing `TENANT_SLUG` because a hosted deployment
 * runs with a tenant catalogue, and the API's configuration refuses `TENANT_SLUG` beside one. A
 * single-tenant (on-premise) install, which sets `TENANT_SLUG` already, may leave
 * `DEMO_SEED_TENANT` unset and the seed uses that tenant — the confirmation is still required.
 *
 * Nothing calls the seeder at boot, at provisioning or at migration. It runs only as its own
 * command (`node apps/api/dist/seed-demo.js`).
 */

export const DEMO_SEED_ENVIRONMENTS = ['development', 'test', 'nonprod'] as const;

export interface DemoSeedPermission {
  readonly allowed: boolean;
  readonly slug: string;
  readonly dryRun: boolean;
  readonly problems: readonly string[];
}

export function checkDemoSeedEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): DemoSeedPermission {
  const problems: string[] = [];
  const slug = (env['DEMO_SEED_TENANT'] ?? env['TENANT_SLUG'] ?? '').trim().toLowerCase();
  const confirm = (env['DEMO_SEED_CONFIRM_TENANT'] ?? '').trim().toLowerCase();
  const environment = (env['DEMO_SEED_ENVIRONMENT'] ?? '').trim().toLowerCase();
  const dryRunRaw = (env['DEMO_SEED_DRY_RUN'] ?? '').trim().toLowerCase();

  if (slug.length === 0) {
    problems.push('Set DEMO_SEED_TENANT to the organisation short name.');
  }
  if (!(DEMO_SEED_ENVIRONMENTS as readonly string[]).includes(environment)) {
    problems.push(
      `Set DEMO_SEED_ENVIRONMENT to one of ${DEMO_SEED_ENVIRONMENTS.join(', ')}. ` +
        'Demo data is never loaded into production.',
    );
  }
  if (slug.length > 0 && confirm !== slug) {
    problems.push(
      'Set DEMO_SEED_CONFIRM_TENANT to the same value as DEMO_SEED_TENANT to confirm the tenant.',
    );
  }
  if (!['', 'true', 'false'].includes(dryRunRaw)) {
    problems.push('DEMO_SEED_DRY_RUN must be true or false.');
  }

  return { allowed: problems.length === 0, slug, dryRun: dryRunRaw === 'true', problems };
}
