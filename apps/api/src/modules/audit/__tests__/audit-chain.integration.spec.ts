import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  type AnyId,
  type DocsAuditAction,
  type TenantId,
  AuditOutcome,
  AuditSubjectType,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AuditActor } from '../../../core/audit/audit-writer.port';
import { GENESIS_HASH, verifyChain } from '../../../core/audit/hash-chain';
import { toChainLink } from '../application/audit-verification.service';
import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { FakeClock } from '../../../testing/fake-ports';
import { ChainedAuditWriter } from '../infrastructure/chained-audit.writer';
import { PlatformAuditRepository } from '../infrastructure/platform-audit.repository';
import { PrismaAuditRepository } from '../infrastructure/prisma-audit.repository';
import { sharedDatabase } from '../../../testing/tenant-database';

/**
 * The audit chain's properties are database properties: ordering under concurrency, what a
 * rollback leaves behind, and whether the grants and the trigger really refuse an edit. None
 * of them can be observed against a double.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const ACME = asId<TenantId>(uuidv7());
const OTHER = asId<TenantId>(uuidv7());

const config = {
  env: 'test',
  database: { url: APP_URL, poolSize: 10 },
} as unknown as AppConfig;

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
const prisma = sharedDatabase(config, logger, APP_URL);
const repository = new PrismaAuditRepository();
const writer = new ChainedAuditWriter(
  new PlatformAuditRepository(repository),
  clock,
  new PrismaUnitOfWork(prisma),
);

function contextFor(tenantId: TenantId): RequestContext {
  return {
    tenantId,
    userId: null,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'audit-integration',
    permissionVersion: 0,
    locale: 'en',
  };
}

function actorFor(tenantId: TenantId): AuditActor {
  return {
    tenantId,
    userId: null,
    channel: 'SYSTEM',
    correlationId: 'audit-integration',
    ipAddress: null,
    userAgent: null,
  };
}

function entry(action: DocsAuditAction) {
  return {
    action,
    subjectType: AuditSubjectType.CONFIGURATION,
    subjectId: asId<AnyId>(uuidv7()),
    outcome: AuditOutcome.SUCCESS,
    payload: { action },
  };
}

/** Writes through the real writer, inside a real tenant context. */
async function record(tenantId: TenantId, action: DocsAuditAction): Promise<void> {
  await runWithContext(contextFor(tenantId), () =>
    writer.writeStandalone(actorFor(tenantId), entry(action)),
  );
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  for (const [tenantId, slug] of [
    [ACME, `acme-${Date.now()}`],
    [OTHER, `other-${Date.now()}`],
  ] as const) {
    await owner.tenant.create({ data: { id: tenantId, slug, name: slug, status: 'ACTIVE' } });
  }
  await owner.$disconnect();
});

describe('the audit chain against PostgreSQL', () => {
  it('starts at genesis and links each event to the last', async () => {
    await record(ACME, 'DOCUMENT_VIEWED');
    await record(ACME, 'DOCUMENT_PRINTED');
    await record(ACME, 'DOCUMENT_SIGNED');

    const events = await runWithContext(contextFor(ACME), () =>
      new PrismaUnitOfWork(prisma).run(() =>
        repository.listForVerification(new Date('2020-01-01'), new Date('2030-01-01')),
      ),
    );

    expect(events).toHaveLength(3);
    expect(events[0]?.previousHash).toBe(GENESIS_HASH);
    expect(events.map((event) => event.sequence)).toEqual([1n, 2n, 3n]);

    const result = verifyChain(events.map(toChainLink), { fromSequence: 1n });
    expect(result).toMatchObject({ intact: true, brokenAt: null, reason: null, verified: 3 });
  });

  it('keeps each tenant on its own chain, both starting at sequence 1', async () => {
    await record(OTHER, 'DOCUMENT_VIEWED');

    const events = await runWithContext(contextFor(OTHER), () =>
      new PrismaUnitOfWork(prisma).run(() =>
        repository.listForVerification(new Date('2020-01-01'), new Date('2030-01-01')),
      ),
    );

    // Row-level security means this tenant cannot even see the other's events, and its own
    // chain begins at genesis rather than continuing someone else's.
    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe(1n);
    expect(events[0]?.previousHash).toBe(GENESIS_HASH);
  });

  it('allocates a gap-free sequence under concurrent writers', async () => {
    // Twelve writers racing on one tenant. Without the advisory lock they read the same tail,
    // compute the same sequence, and the unique constraint turns the race into failures.
    await Promise.all(Array.from({ length: 12 }, () => record(ACME, 'DOCUMENT_VIEWED')));

    const events = await runWithContext(contextFor(ACME), () =>
      new PrismaUnitOfWork(prisma).run(() =>
        repository.listForVerification(new Date('2020-01-01'), new Date('2030-01-01')),
      ),
    );

    const sequences = events.map((event) => Number(event.sequence));
    expect(sequences).toEqual(Array.from({ length: sequences.length }, (_, i) => i + 1));

    const result = verifyChain(events.map(toChainLink), { fromSequence: 1n });
    expect(result.intact).toBe(true);
  });

  it('refuses an update or a delete, even for the owner role', async () => {
    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

    // The tenant context has to be set for the rows to be visible at all: FORCE ROW LEVEL
    // SECURITY applies to the table owner too, so a context-less session sees nothing and an
    // UPDATE silently matches zero rows. Protected twice over — but only the second layer is
    // under test here, so the first has to be satisfied first.
    const attempt = (statement: string): Promise<unknown> =>
      owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", ACME);
        return tx.$executeRawUnsafe(statement);
      });

    await expect(attempt("UPDATE audit_event SET action = 'TAMPERED'")).rejects.toThrowError(
      /append-only/,
    );
    await expect(attempt('DELETE FROM audit_event')).rejects.toThrowError(/append-only/);

    // And nothing was changed by the attempts.
    const untouched = await owner.$queryRawUnsafe<{ count: bigint }[]>(
      "SELECT count(*) AS count FROM audit_event WHERE action = 'TAMPERED'",
    );
    expect(Number(untouched[0]?.count ?? 0)).toBe(0);

    await owner.$disconnect();
  });

  it('refuses to write outside a transaction, rather than opening one of its own', async () => {
    // `write()` records something that is committing alongside it. With no transaction there is
    // nothing to be atomic with, and quietly opening one would let a rolled-back change leave a
    // permanent record of something that never happened.
    await expect(
      runWithContext(contextFor(ACME), () =>
        writer.write(actorFor(ACME), entry('DOCUMENT_VIEWED')),
      ),
    ).rejects.toThrowError(/must run inside the transaction/);
  });
});
