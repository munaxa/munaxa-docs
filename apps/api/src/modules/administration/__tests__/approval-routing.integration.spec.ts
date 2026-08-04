import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKING_CALENDAR,
  ParticipantKind,
  StageCompletionRule,
  type TenantId,
  type UserId,
  asId,
  deadlineFor,
  parseDuration,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { realWriteStack } from '../../../testing/real-collaborators';
import { sharedDatabase } from '../../../testing/tenant-database';
import { ApprovalRoutingService } from '../application/approval-routing.service';
import { PrismaApprovalRoutingRepository } from '../infrastructure/prisma-approval-routing.repository';

/**
 * Approval groups and working calendars, against a real PostgreSQL.
 *
 * Four assertions here are database questions rather than service questions, which is why they are
 * in this suite:
 *
 *  - **One default calendar per tenant.** Setting a second moves the flag rather than adding one,
 *    and the partial unique index underneath is what makes that true when something other than the
 *    service writes.
 *  - **"Which workflows route to this group" is a `jsonb` containment query.** A definition's stages
 *    are stored as validated JSON, so the count that stops a group in use from being deleted asks
 *    PostgreSQL rather than parsing anything — and a key that merely appears in a stage's *name*
 *    must not count.
 *  - **A holiday is a calendar date.** `@db.Date` round-trips through UTC midnight, and a read that
 *    applied a local offset would move half a year's holidays by a day.
 *  - **The engine and the preview agree.** The deadline a screen promises and the deadline the
 *    engine enforces come from one function over one stored calendar.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-03-02T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
const ADA = asId<UserId>(uuidv7());
const GRACE = asId<UserId>(uuidv7());

let owner: PrismaClient;
let routing: ApprovalRoutingService;

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}${String(counter).padStart(3, '0')}`;
}

function as<T>(work: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    tenantId: TENANT,
    userId: ADA,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'approval-routing',
    permissionVersion: 1,
    locale: 'en',
  };
  return runWithContext(context, work);
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const appConfig = {
    env: 'test',
    database: { url: APP_URL, poolSize: 10 },
  } as unknown as AppConfig;
  const unitOfWork = new PrismaUnitOfWork(sharedDatabase(appConfig, logger, APP_URL));
  const { stamps, writer } = realWriteStack(clock, unitOfWork);
  routing = new ApprovalRoutingService(new PrismaApprovalRoutingRepository(stamps), writer);

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `routing-${String(Date.now())}-${TENANT.slice(0, 8)}`,
      name: 'Approval Routing Test',
      status: 'ACTIVE',
    },
  });
  for (const id of [ADA, GRACE]) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: `${id}@example.test`,
        emailNormalized: `${id}@example.test`,
        displayName: 'Test User',
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await owner?.$disconnect();
});

describe('approval groups', () => {
  it('resolves its active members, in name order, and nobody once deactivated', async () => {
    const key = unique('group-');
    const group = await as(() =>
      routing.createGroup({ key, name: 'Safety reviewers', memberIds: [ADA, GRACE] }),
    );
    expect(await as(() => routing.membersOfGroup(key))).toHaveLength(2);

    await as(() => routing.updateGroup(group.id, { isActive: false }, group.version));
    // Deactivating is how an administrator stops a group routing, so a resolver that ignored the
    // flag would make that switch do nothing at all.
    expect(await as(() => routing.membersOfGroup(key))).toEqual([]);
  });

  it('excludes a member whose account has been disabled', async () => {
    const key = unique('group-');
    await as(() => routing.createGroup({ key, name: 'Reviewers', memberIds: [ADA, GRACE] }));
    await owner.user.update({ where: { id: GRACE }, data: { status: 'DISABLED' } });

    // A resolver yielding a disabled account routes an approval to somebody who cannot sign in,
    // and the stage would sit there until it escalated — which looks exactly like somebody
    // ignoring their work.
    expect(await as(() => routing.membersOfGroup(key))).toEqual([ADA]);
    await owner.user.update({ where: { id: GRACE }, data: { status: 'ACTIVE' } });
  });

  it('refuses to delete a group a published workflow routes to', async () => {
    const key = unique('group-');
    const group = await as(() => routing.createGroup({ key, name: 'In use', memberIds: [ADA] }));

    const definition = await owner.workflowDefinition.create({
      data: {
        id: uuidv7(),
        tenantId: TENANT,
        key: unique('wf-'),
        name: 'Uses the group',
        updatedAt: FIXED_NOW,
      },
    });
    await owner.workflowVersion.create({
      data: {
        id: uuidv7(),
        tenantId: TENANT,
        definitionId: definition.id,
        version: 1,
        state: 'PUBLISHED',
        publishedAt: FIXED_NOW,
        publishedBy: ADA,
        updatedAt: FIXED_NOW,
        definition: {
          appliesTo: { documentTypes: [], condition: null },
          stages: [
            {
              name: 'Safety',
              participants: [{ kind: ParticipantKind.GROUP, groupKey: key }],
              completionRule: StageCompletionRule.ALL,
            },
          ],
          onComplete: { assignNumber: true, publish: 'IMMEDIATELY' },
        },
      },
    });

    const inUse = await as(() => routing.getGroup(group.id));
    expect(inUse.usedByWorkflowCount).toBe(1);
    await expect(as(() => routing.deleteGroup(group.id, inUse.version))).rejects.toThrow(
      /still routes to this group/i,
    );
  });

  it('does not count a group key that merely appears in a stage’s name', async () => {
    const key = unique('group-');
    const group = await as(() =>
      routing.createGroup({ key, name: 'Not in use', memberIds: [ADA] }),
    );

    const definition = await owner.workflowDefinition.create({
      data: {
        id: uuidv7(),
        tenantId: TENANT,
        key: unique('wf-'),
        name: 'Mentions it',
        updatedAt: FIXED_NOW,
      },
    });
    await owner.workflowVersion.create({
      data: {
        id: uuidv7(),
        tenantId: TENANT,
        definitionId: definition.id,
        version: 1,
        state: 'PUBLISHED',
        publishedAt: FIXED_NOW,
        publishedBy: ADA,
        updatedAt: FIXED_NOW,
        definition: {
          appliesTo: { documentTypes: [], condition: null },
          // The key in the *name*, not in a participant. A `LIKE` over the serialised JSON would
          // count this and refuse a delete that is perfectly safe.
          stages: [
            {
              name: `Reviewed by ${key}`,
              participants: [{ kind: ParticipantKind.OWNER }],
              completionRule: StageCompletionRule.ALL,
            },
          ],
          onComplete: { assignNumber: true, publish: 'IMMEDIATELY' },
        },
      },
    });

    expect((await as(() => routing.getGroup(group.id))).usedByWorkflowCount).toBe(0);
  });
});

describe('working calendars', () => {
  it('keeps exactly one default per tenant', async () => {
    const first = await as(() =>
      routing.createCalendar({
        code: unique('CAL'),
        name: 'Head office',
        entityId: null,
        weekendDays: [6, 7],
        isDefault: true,
        holidays: [],
      }),
    );
    const second = await as(() =>
      routing.createCalendar({
        code: unique('CAL'),
        name: 'Second office',
        entityId: null,
        weekendDays: [5, 6],
        isDefault: true,
        holidays: [],
      }),
    );

    // A tenant with two defaults has none: the deadline arithmetic would depend on which row a
    // query happened to return first. Setting a second moves the flag.
    const defaults = await owner.workingCalendar.findMany({
      where: { tenantId: TENANT, isDefault: true, deletedAt: null },
    });
    expect(defaults.map((row) => row.id)).toEqual([second.id]);
    void first;
  });

  it('refuses to remove the default, and refuses a week with no working day', async () => {
    const current = await as(() => routing.calendarForEntity(null));
    expect(current).not.toBeNull();
    await expect(as(() => routing.deleteCalendar(current!.id, current!.version))).rejects.toThrow(
      /another calendar the default/i,
    );

    await expect(
      as(() =>
        routing.createCalendar({
          code: unique('CAL'),
          name: 'Never open',
          entityId: null,
          weekendDays: [1, 2, 3, 4, 5, 6, 7],
          isDefault: false,
          holidays: [],
        }),
      ),
    ).rejects.toThrow(/at least one working day/i);
  });

  it('round-trips a holiday as the calendar date it was given', async () => {
    const calendar = await as(() =>
      routing.createCalendar({
        code: unique('CAL'),
        name: 'With holidays',
        entityId: null,
        weekendDays: [6, 7],
        isDefault: false,
        holidays: [
          { day: '2026-12-25', name: 'Christmas' },
          { day: '2026-01-01', name: 'New Year' },
        ],
      }),
    );
    // Stored as a `date` and read back from its UTC parts. Anything that applied a local offset
    // would put Christmas on the 24th for half the world.
    expect(calendar.holidays.map((holiday) => holiday.day)).toEqual(['2026-01-01', '2026-12-25']);
  });

  it('refuses the same day twice, naming the date', async () => {
    await expect(
      as(() =>
        routing.createCalendar({
          code: unique('CAL'),
          name: 'Duplicated',
          entityId: null,
          weekendDays: [6, 7],
          isDefault: false,
          holidays: [
            { day: '2026-05-01', name: 'Labour day' },
            { day: '2026-05-01', name: 'Also labour day' },
          ],
        }),
      ),
    ).rejects.toThrow(/2026-05-01/);
  });

  it('gives the engine and a preview the same answer', async () => {
    const code = unique('CAL');
    await as(() =>
      routing.createCalendar({
        code,
        name: 'Engine and preview',
        entityId: null,
        weekendDays: [6, 7],
        isDefault: true,
        holidays: [{ day: '2026-03-04', name: 'Company day' }],
      }),
    );

    const stored = await as(() => routing.calendarForEntity(null));
    expect(stored?.code).toBe(code);

    const view = {
      ...DEFAULT_WORKING_CALENDAR,
      weekendDays: stored!.weekendDays,
      holidays: new Set(stored!.holidays.map((holiday) => holiday.day)),
    };
    // Monday + 3 working days with Wednesday a holiday is Friday. One function over one stored
    // calendar, so the deadline a screen promises is the deadline the engine enforces.
    const due = deadlineFor(FIXED_NOW, parseDuration('P3D')!, 'WORKING_DAYS', view);
    expect(due.toISOString()).toBe('2026-03-06T09:00:00.000Z');
  });
});
