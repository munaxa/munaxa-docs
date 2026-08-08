import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@edms/utils';

/**
 * The invariant `document_signature` has described since Phase 16 and never enforced — Phase 6.7.
 *
 * The table's own comment reads *"One live signature per person, revision and purpose. Partial on
 * `withdrawn_at`."* The three declarations beneath it were `@@index`, and the migration that made
 * them emitted three plain `CREATE INDEX`, so nothing enforced it. `DocumentSignatureService`
 * checks `liveSignatureExists` and then inserts — a read-then-write — and `TenantDatabase`
 * opens its transaction with no `isolationLevel`, so under READ COMMITTED both callers of a
 * concurrent pair could pass that check and both could insert. Phase 6.6 stopped on it.
 *
 * ## Why these assertions run against the database rather than through the service
 *
 * Because the database is now the authority, and that is precisely the claim under test. The
 * service's check is a courtesy that turns the common sequential case into a friendly message; it
 * is *not* what makes the invariant true, and a test driven through the service would pass just as
 * well with the index absent — which is the state Phase 6.6 found and reported. What can only be
 * observed here is two genuine transactions, open at the same time against the same rows, one of
 * which must lose.
 *
 * Nothing is mocked, nothing is serialised artificially, and the race is run repeatedly rather than
 * once, because a single scheduling order proves nothing about a race.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';

let owner: PrismaClient;

/** Identifiers only — the fixture never needs a real document, revision or person to race on. */
const TENANT = uuidv7();
const OTHER_TENANT = uuidv7();

interface Attempt {
  readonly tenantId?: string;
  readonly revisionId?: string;
  readonly signerUserId?: string;
  readonly purpose?: string;
  readonly withdrawn?: boolean;
}

/**
 * One row's worth of columns, written straight to the table.
 *
 * `document_signature` has foreign keys to `document`, `document_revision` and `user`, so the rows
 * here are inserted with `session_replication_role = replica` for the duration of the statement —
 * the standard way to assert an index in isolation without standing up five aggregates whose own
 * suites already cover them. The index under test is unaffected by that setting; triggers and
 * foreign keys are, which is the point.
 */
function valuesFor(attempt: Attempt): string {
  const withdrawn = attempt.withdrawn === true ? 'now()' : 'NULL';
  return `(
    '${uuidv7()}'::uuid,
    '${attempt.tenantId ?? TENANT}'::uuid,
    '${DOCUMENT}'::uuid,
    '${attempt.revisionId ?? REVISION}'::uuid,
    '${attempt.signerUserId ?? SIGNER}'::uuid,
    '${attempt.purpose ?? 'APPROVAL'}'::signature_purpose,
    'digest', 'body', 'witness', 'HMAC-SHA256', 'key', now(), true, ${withdrawn}
  )`;
}

const COLUMNS =
  '(id, tenant_id, document_id, revision_id, signer_user_id, purpose, content_sha256, ' +
  'statement_body, signature, algorithm, key_id, signed_at, reauthenticated, withdrawn_at)';

const DOCUMENT = uuidv7();
const REVISION = uuidv7();
const SIGNER = uuidv7();

async function insert(client: PrismaClient, attempt: Attempt = {}): Promise<void> {
  // Inside a transaction with `SET LOCAL`, never a bare `SET`. Prisma pools connections, so a
  // session-scoped `session_replication_role = replica` would outlive this statement and silently
  // disable foreign-key enforcement for whichever suite drew the same connection next — a test
  // that quietly weakens other tests. `SET LOCAL` is reverted on commit.
  //
  // Two statements, because PostgreSQL refuses more than one command in a prepared statement.
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
    await tx.$executeRawUnsafe(
      `INSERT INTO document_signature ${COLUMNS} VALUES ${valuesFor(attempt)}`,
    );
  });
}

/** Everything live for the canonical signer/revision/purpose. */
async function liveCount(): Promise<number> {
  const rows = await owner.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM document_signature
     WHERE tenant_id = $1::uuid AND revision_id = $2::uuid
       AND signer_user_id = $3::uuid AND purpose = 'APPROVAL' AND withdrawn_at IS NULL`,
    TENANT,
    REVISION,
    SIGNER,
  );
  return Number(rows[0]?.count ?? 0n);
}

beforeAll(() => {
  if (!OWNER_URL) {
    throw new Error('DATABASE_MIGRATION_URL must be set.');
  }
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
});

afterAll(async () => {
  await owner?.$executeRawUnsafe(
    `DELETE FROM document_signature WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT,
    OTHER_TENANT,
  );
  await owner?.$disconnect();
});

describe('the live-signature constraint exists at all', () => {
  it('is a unique index, partial on withdrawn_at', async () => {
    // Asserted against `pg_indexes` rather than against the Prisma schema, because the schema is
    // where the *claim* lived for six phases while the constraint did not. Prisma cannot express a
    // partial unique index, so this one is declared in migration SQL only — the same convention
    // `uq_user_department_primary` and `uq_department_entity_code` already follow.
    const rows = await owner.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_document_signature_live'`,
    );
    const definition = rows[0]?.indexdef ?? '';
    expect(definition).toContain('CREATE UNIQUE INDEX');
    expect(definition).toContain('tenant_id');
    expect(definition).toContain('revision_id');
    expect(definition).toContain('signer_user_id');
    expect(definition).toContain('purpose');
    expect(definition).toContain('withdrawn_at IS NULL');
  });
});

describe('two concurrent signatures cannot both become live', () => {
  it('lets exactly one of a genuine race win, repeatedly', async () => {
    // Ten rounds, because one scheduling order is an anecdote. Each round opens two transactions
    // that both insert before either commits, which is the shape the service's read-then-write
    // check cannot see.
    for (let round = 0; round < 10; round += 1) {
      const revisionId = uuidv7();
      const left = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
      const right = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

      const outcomes = await Promise.allSettled([
        left.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
          await tx.$executeRawUnsafe(
            `INSERT INTO document_signature ${COLUMNS} VALUES ${valuesFor({ revisionId })}`,
          );
          // Held open briefly so both inserts are genuinely in flight before either commits —
          // which is the state the service's read-then-write check cannot observe.
          await new Promise((resolve) => setTimeout(resolve, 50));
        }),
        right.$transaction(async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
          await tx.$executeRawUnsafe(
            `INSERT INTO document_signature ${COLUMNS} VALUES ${valuesFor({ revisionId })}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }),
      ]);

      await left.$disconnect();
      await right.$disconnect();

      const won = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
      const lost = outcomes.filter((outcome) => outcome.status === 'rejected');

      // Exactly one, every round. Not "at most one" — losing both would mean the index was
      // rejecting something it should not.
      expect(won, `round ${String(round)}`).toBe(1);
      expect(lost).toHaveLength(1);
      // And the loser failed for the stated reason. `23505` is PostgreSQL's `unique_violation`,
      // asserted rather than the index name because a raw query surfaces the SQLSTATE while
      // Prisma's typed `create()` surfaces `P2002` with the index in `meta` — which is what
      // `PrismaSignatureRepository.insert` matches on for the real path.
      expect(JSON.stringify((lost[0] as PromiseRejectedResult).reason)).toContain('23505');

      const rows = await owner.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM document_signature WHERE revision_id = $1::uuid`,
        revisionId,
      );
      expect(Number(rows[0]?.count ?? 0n), `round ${String(round)}`).toBe(1);
    }
  });
});

describe('the constraint permits everything the domain permits', () => {
  it('allows a withdrawn signature to be replaced by a new live one', async () => {
    // ADR-0017 §7 makes withdrawal a row's own columns rather than a delete, so a signer may take a
    // signature back and sign again. A *total* unique index would have made withdrawal one-way and
    // turned an ordinary correction into a permanent bar — which is why this one is partial.
    await insert(owner, { withdrawn: true });
    await expect(insert(owner)).resolves.toBeUndefined();
    expect(await liveCount()).toBe(1);
  });

  it('refuses a second live signature for the same signer, revision and purpose', async () => {
    // The sequential case, which the service also refuses — asserted here so the index is known to
    // be the backstop rather than merely present.
    await expect(insert(owner)).rejects.toThrowError(/23505|Unique constraint/);
  });

  it('allows the same signer to sign a different revision', async () => {
    await expect(insert(owner, { revisionId: uuidv7() })).resolves.toBeUndefined();
  });

  it('allows the same signer to sign the same revision for a different purpose', async () => {
    // Signing as author and again as approver is an ordinary act, and `purpose` is what
    // distinguishes them.
    await expect(insert(owner, { purpose: 'AUTHORSHIP' })).resolves.toBeUndefined();
  });

  it('allows a different signer to sign the same revision for the same purpose', async () => {
    // Two approvers on one revision is the normal case, not an exception.
    await expect(insert(owner, { signerUserId: uuidv7() })).resolves.toBeUndefined();
  });

  it('does not let one tenant’s signature collide with another’s', async () => {
    // The identifiers are deliberately identical apart from the tenant. Under ADR-0015 these live
    // in separate databases anyway, so this asserts the key's shape rather than the isolation —
    // a key that omitted `tenant_id` would be wrong even though nothing could exploit it today.
    await expect(insert(owner, { tenantId: OTHER_TENANT })).resolves.toBeUndefined();
  });
});
