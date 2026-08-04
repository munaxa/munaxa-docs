import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';

import { type NumberingRuleId, type TenantId, asId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { sharedDatabase } from '../../../testing/tenant-database';
import { PrismaNumberIssueRepository } from '../infrastructure/prisma-number-issue.repository';

/**
 * The counter under concurrency — the risk `09-numbering-architecture.md` §2 designs around and
 * §5 makes the first guarantee: parallel draws in one series all distinct, two series never
 * touching. These are properties of a real PostgreSQL row lock, and a repository double cannot
 * be asked about them because it is written from the same belief as the code it stands in for.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const TENANT = asId<TenantId>(uuidv7());
const RULE = asId<NumberingRuleId>(uuidv7());
const NOW = new Date('2026-03-02T09:00:00.000Z');

const config = { env: 'test', database: { url: APP_URL, poolSize: 20 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const repository = new PrismaNumberIssueRepository();

const context: RequestContext = {
  tenantId: TENANT,
  userId: null,
  roles: [],
  permissions: [],
  sessionId: null,
  correlationId: 'numbering-issue-integration',
  permissionVersion: 0,
  locale: 'en',
};

function claim(scopeKey: string): Promise<bigint> {
  return runWithContext(context, () =>
    unitOfWork.run(() =>
      repository.claimNext({
        numberingRuleId: RULE,
        scopeKey,
        freshId: uuidv7(),
        at: NOW,
      }),
    ),
  );
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  const slug = `numbering-${Date.now()}`;
  await owner.tenant.create({ data: { id: TENANT, slug, name: slug, status: 'ACTIVE' } });
  await owner.numberingRule.create({
    data: {
      id: RULE,
      tenantId: TENANT,
      key: slug,
      name: 'Issuance',
      separator: '-',
      segments: [{ kind: 'SEQUENCE', padding: 4 }],
      resetScope: ['NEVER'],
    },
  });
  await owner.$disconnect();
});

describe('the sequence counter against PostgreSQL', () => {
  it('gives a hundred parallel draws in one series a hundred distinct, gapless values', async () => {
    // §5's first guarantee, asked of the database itself. Every draw is its own transaction, all
    // hundred contend on one row, and the claim is one statement — so the answers must be exactly
    // 1..100 in *some* order. A duplicate here is a duplicate document number in the field.
    const values = await Promise.all(Array.from({ length: 100 }, () => claim('ALL')));

    const distinct = new Set(values.map((value) => value.toString()));
    expect(distinct.size).toBe(100);
    const sorted = [...values].sort((left, right) => (left < right ? -1 : 1));
    expect(sorted[0]).toBe(1n);
    expect(sorted[99]).toBe(100n);
  });

  it('keeps two series fully independent', async () => {
    const [first, second] = await Promise.all([claim('ENTITY:JO'), claim('ENTITY:SA')]);
    // Each series starts its own count at 1: the other's hundred draws did not move it.
    expect(first).toBe(1n);
    expect(second).toBe(1n);
  });

  it('fast-forwards past a supplied value and never backwards', async () => {
    await runWithContext(context, () =>
      unitOfWork.run(() =>
        repository.fastForward({
          numberingRuleId: RULE,
          scopeKey: 'ENTITY:JO',
          past: 500n,
          freshId: uuidv7(),
          at: NOW,
        }),
      ),
    );
    expect(await claim('ENTITY:JO')).toBe(501n);

    // An import older than the series is a no-op on the counter: `GREATEST` on the conflict arm,
    // because moving a counter backwards re-issues everything between (§3).
    await runWithContext(context, () =>
      unitOfWork.run(() =>
        repository.fastForward({
          numberingRuleId: RULE,
          scopeKey: 'ENTITY:JO',
          past: 10n,
          freshId: uuidv7(),
          at: NOW,
        }),
      ),
    );
    expect(await claim('ENTITY:JO')).toBe(502n);
  });

  it('takes a rolled-back claim with the transaction that made it', async () => {
    const before = await claim('ROLLBACK');
    await runWithContext(context, () =>
      unitOfWork
        .run(async () => {
          await repository.claimNext({
            numberingRuleId: RULE,
            scopeKey: 'ROLLBACK',
            freshId: uuidv7(),
            at: NOW,
          });
          throw new Error('deliberate rollback');
        })
        .catch(() => undefined),
    );
    // The rolled-back transaction never happened, counter included. The gap ADR-0004 tolerates
    // is a *voided reservation*, which is a committed fact — not a counter that half-moved.
    expect(await claim('ROLLBACK')).toBe(before + 1n);
  });
});
