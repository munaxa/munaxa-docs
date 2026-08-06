import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiScope, Permission, permissionsForScopes, type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { loadConfig } from '../core/config/configuration';

/**
 * The security *controls*, asserted as controls rather than as features — Phase 18.
 *
 * ## What this suite is for, and what it deliberately is not
 *
 * Sixteen phases built the controls this product's security posture rests on, and every one of
 * them is already tested by the suite that built it: deny-precedence in the ACL walk is
 * `acl.integration.spec.ts`; the empty predicate Phase 17 made unrepresentable is
 * `integration-platform.integration.spec.ts`'s two keys with different totals; the outbound
 * allow-list is `allow-listed-http.adapter.spec.ts`, which asserts that no socket opens; the hash
 * chain's three digest versions are `audit-chain.integration.spec.ts`. **Restating any of those
 * here would be ceremony** — a second assertion of the same property, in a file named "security",
 * proving nothing the first did not and doubling what a change to the property costs.
 *
 * So this suite asserts only what those cannot: the properties that are about the *whole* of the
 * product rather than about one capability, and which therefore have no owning suite. Each of the
 * four below fails when a **future** phase adds something and forgets a rule, which is the only
 * kind of security test that earns its place in a codebase where the controls are already tested.
 *
 * 1. **Every tenant-scoped table isolates**, discovered from the catalogue rather than listed —
 *    so a table added in Phase 19 is covered on the day it is written.
 * 2. **No API-key scope reaches the permissions no machine may hold.**
 * 3. **Production refuses every configuration that would weaken a control.**
 *
 * A fourth was considered and became a *boot* check instead of a test, which is strictly stronger:
 * `RoutePermissionRegistry` now refuses to start when a route declares a permission the catalogue
 * does not contain. A misspelt permission is a route that refuses everybody for ever, which reads
 * to a customer as a broken feature rather than as a defect — and an assertion in a suite is a
 * thing somebody can skip, while a process that will not start is not.
 *
 * The pen-test scope, the test-account story and what a tester may do to a tenant's data are a
 * different artefact and are in `docs/operations/penetration-testing.md`.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const ACME = asId<TenantId>(uuidv7());
const RIVAL = asId<TenantId>(uuidv7());

let owner: PrismaClient;
let app: PrismaClient;

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: APP_URL } } });

  for (const [id, name] of [
    [ACME, 'Acme'],
    [RIVAL, 'Rival'],
  ] as const) {
    await owner.tenant.create({
      data: {
        id,
        slug: `sec-${id.replaceAll('-', '').slice(-16)}`,
        name,
        status: 'ACTIVE',
      },
    });
  }
}, 120_000);

afterAll(async () => {
  await owner?.$disconnect();
  await app?.$disconnect();
});

// --- 1. Isolation, over every table there is ---------------------------------------------------

/**
 * Every tenant-scoped table, discovered the way the post-migration SQL discovers them.
 *
 * The same query, deliberately: if the two ever diverge, the gate protects a set of tables and the
 * suite asserts a different one, and the difference is exactly where a hole would be.
 */
async function tenantScopedTables(): Promise<readonly string[]> {
  const rows = await owner.$queryRawUnsafe<{ relname: string }[]>(`
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relname <> 'tenant'
      AND NOT c.relname LIKE '\\_prisma%'
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = c.relname AND column_name = 'tenant_id'
      )
    ORDER BY c.relname`);
  return rows.map((row) => row.relname);
}

describe('row-level security, on every tenant-scoped table', () => {
  it('finds tables to protect at all', async () => {
    // The assertion that stops every check below from passing vacuously if the discovery query
    // ever stops matching — which is the failure mode of a suite built on discovery.
    expect((await tenantScopedTables()).length).toBeGreaterThan(30);
  });

  it('has row-level security ENABLED and FORCED on each of them', async () => {
    // **`FORCE` is the half the deploy gate does not check**, and it is the half that matters
    // most here: without it the table *owner* bypasses the policy, and the owner is who migrations
    // and maintenance run as. `infra/sql/post-migrate/01-tenant-isolation.sql` sets both and
    // verifies only `relrowsecurity`, so a table that lost its FORCE would deploy green.
    const tables = await tenantScopedTables();
    const rows = await owner.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`);
    const byName = new Map(rows.map((row) => [row.relname, row]));

    const unprotected = tables.filter(
      (table) =>
        byName.get(table)?.relrowsecurity !== true ||
        byName.get(table)?.relforcerowsecurity !== true,
    );

    expect(unprotected).toEqual([]);
  });

  it('carries the tenant_isolation policy on each of them', async () => {
    const tables = await tenantScopedTables();
    const rows = await owner.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`,
    );
    const withPolicy = new Set(rows.map((row) => row.tablename));

    expect(tables.filter((table) => !withPolicy.has(table))).toEqual([]);
  });

  it('hides another tenant’s rows from the application role, on every one of them', async () => {
    // The behavioural assertion, and the reason the three above are not enough: a policy can exist
    // and be wrong. This asks the question a request asks — as `edms_app`, with one tenant set,
    // how many of the *other* tenant's rows are visible — of every table at once, so a table whose
    // policy names the wrong column is caught on the day it is added.
    //
    // It runs as the application role deliberately. CI's `edms_owner` is the cluster superuser, so
    // a suite that asked this question as the owner would be asking it of a connection that
    // bypasses every policy — which is Phase 14's finding, restated as a rule this file follows.
    const tables = await tenantScopedTables();

    const leaking = await app.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", ACME);
      const found: string[] = [];
      for (const table of tables) {
        const rows = await tx.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*)::bigint AS count FROM "${table}" WHERE tenant_id <> $1::uuid`,
          ACME,
        );
        if ((rows[0]?.count ?? 0n) > 0n) {
          found.push(table);
        }
      }
      return found;
    });

    expect(leaking).toEqual([]);
  });

  it('refuses a write that names another tenant, whatever the application intended', async () => {
    // Layer 5 of 17 §4, asserted directly: the `WITH CHECK` half of the policy. Every layer above
    // it — the token, the context, the guard, the Prisma extension — is asserted by its own suite;
    // this is the one that holds when all four have a bug at once.
    await expect(
      app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", ACME);
        // `outbox_message` because it is the tenant-scoped table with the fewest foreign keys —
        // the assertion is about the policy, and a row refused by a missing parent would pass this
        // test for the wrong reason.
        await tx.$executeRawUnsafe(
          `INSERT INTO outbox_message
             (id, tenant_id, aggregate_type, aggregate_id, event_type, payload, correlation_id)
           VALUES ($1::uuid, $2::uuid, 'security', $1::uuid, 'security.probe', '{}'::jsonb, 'probe')`,
          uuidv7(),
          RIVAL,
        );
      }),
    ).rejects.toThrow(/row-level security|violates/i);
  });
});

// --- 2. What no machine may ever hold ----------------------------------------------------------

describe('API key scopes', () => {
  /**
   * The property ADR-0018 buys by keeping scopes coarse: a permission absent from every scope's
   * list is unreachable by any key, whatever a tenant administrator configures.
   */
  const REACHABLE: ReadonlySet<string> = new Set(permissionsForScopes(Object.values(ApiScope)));

  it.each<[string, string]>([
    [
      Permission.DOCUMENT_SIGN,
      '21 CFR Part 11 §11.200: a key in a script is not two components a person alone controls',
    ],
    [Permission.USER_MANAGE, 'a key that can mint people can mint itself a better one'],
    [Permission.ROLE_MANAGE, 'likewise for the grants behind them'],
    [
      Permission.SETTINGS_MANAGE,
      'a key that can change the tenant’s configuration can disable the controls above',
    ],
  ])('never admits %s — %s', (permission) => {
    expect(REACHABLE.has(permission)).toBe(false);
  });

  it('does admit the ordinary document permissions, so the exclusions mean something', () => {
    // Without this, a `permissionsForScopes` that returned nothing at all would pass every
    // assertion above — the classic way a negative test suite becomes decoration.
    expect(REACHABLE.has(Permission.DOCUMENT_VIEW)).toBe(true);
  });
});

// --- 3. The configurations production refuses --------------------------------------------------

describe('production boot refusals', () => {
  const base = {
    DATABASE_URL: 'postgresql://app:secret@localhost:5432/edms',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    TENANT_ID: '019489f0-0000-7000-8000-000000000001',
    TENANT_SLUG: 'acme',
    NODE_ENV: 'production',
    OPENAPI_ENABLED: 'false',
    STORAGE_DRIVER: 'S3',
    STORAGE_BUCKET: 'edms-prod',
    MAIL_DRIVER: 'RESEND',
    MAIL_RESEND_API_KEY: 're_ci_only_not_a_secret',
    MAIL_FROM_ADDRESS: 'docs@munaxa.com',
    AV_DRIVER: 'ICAP',
    AUDIT_CHECKPOINT_SECRET: 'c'.repeat(32),
    SIGNATURE_WITNESS_SECRET: 's'.repeat(32),
    MFA_TOTP_SEALING_KEY: 'm'.repeat(32),
  } satisfies NodeJS.ProcessEnv;

  it('boots on the configuration every refusal below varies', () => {
    // The control. Every case below removes or weakens exactly one thing from this, so a failure
    // names the control rather than the fixture.
    expect(() => loadConfig({ ...base })).not.toThrow();
  });

  it.each([
    ['the antivirus gate', { AV_DRIVER: 'NONE' }],
    ['object storage', { STORAGE_DRIVER: 'NONE' }],
    ['a mail provider', { MAIL_DRIVER: 'NONE' }],
    ['the audit checkpoint key', { AUDIT_CHECKPOINT_SECRET: undefined }],
    ['the signature witness key', { SIGNATURE_WITNESS_SECRET: undefined }],
    ['the authenticator sealing key', { MFA_TOTP_SEALING_KEY: undefined }],
  ])('refuses to start production without %s', (_case, override) => {
    expect(() => loadConfig({ ...base, ...override })).toThrow();
  });

  it.each([
    ['plaintext outbound requests', { OUTBOUND_HTTP_ALLOW_INSECURE: 'true' }],
    ['the interactive OpenAPI explorer', { OPENAPI_ENABLED: 'true' }],
    ['a signing secret below the minimum length', { JWT_ACCESS_SECRET: 'short' }],
    [
      'SMTP without transport security',
      { MAIL_DRIVER: 'SMTP', MAIL_SMTP_HOST: 'relay.internal', MAIL_SMTP_SECURITY: 'NONE' },
    ],
  ])('refuses to start production with %s', (_case, override) => {
    expect(() => loadConfig({ ...base, ...override })).toThrow();
  });

  it('leaves the outbound allow-list empty by default, so nothing is reachable', () => {
    // 17 §6's posture, and the one default in the product whose *emptiness* is the control.
    expect(loadConfig({ ...base }).outbound.allowList).toEqual([]);
  });
});
