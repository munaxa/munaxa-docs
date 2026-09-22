import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  AuditSubjectType,
  type ReportDefinitionId,
  DigestFrequency,
  NotificationChannel,
  type AnyId,
  type TenantId,
  type UserId,
  TenantStatus,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../core/config/configuration';
import { TenantReadOnlyError } from '../core/errors/application-errors';
import type { Logger } from '../core/observability/logger';
import { PrismaUnitOfWork } from '../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../core/tenancy/tenant-context';
import {
  type AdministeredWriter,
  AdministrativeOperation,
} from '../core/persistence/administered-writer';
import { NotificationAdminService } from '../modules/notification/application/notification-admin.service';
import { NotificationType } from '../modules/notification/domain/notification-types';
import {
  PrismaNotificationPreferenceRepository,
  PrismaNotificationSuppressionRepository,
  PrismaNotificationTemplateRepository,
} from '../modules/notification/infrastructure/prisma-notification.repositories';
import { ReportDefinitionService } from '../modules/reporting/application/report-definition.service';
import { PrismaReportDefinitionRepository } from '../modules/reporting/infrastructure/prisma-reporting.repositories';
import { SavedSearchService } from '../modules/search/application/saved-search.service';
import {
  PrismaRecentSearchRepository,
  PrismaSavedSearchRepository,
} from '../modules/search/infrastructure/prisma-search.repositories';
import { realWriteStack } from '../testing/real-collaborators';
import { sharedDatabase } from '../testing/tenant-database';

/**
 * "A suspended tenant is read-only, everywhere" — `08-permission-model.md` §4.
 *
 * `AdministeredWriter.write` reads the tenant's row inside the transaction that is about to write
 * and refuses when it is not `ACTIVE`, and its own comment says why it lives there rather than at
 * each endpoint: *"'everywhere' is the requirement, and eighteen resources each remembering to
 * check is seventeen chances to forget."*
 *
 * This suite is the check that the requirement is met, which nothing asserted before it.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-04-06T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
const USER = asId<UserId>(uuidv7());

let owner: PrismaClient;
let writer: AdministeredWriter;
let definitions: ReportDefinitionService;
let searches: SavedSearchService;
let notifications: NotificationAdminService;
let suppressions: PrismaNotificationSuppressionRepository;

function as<T>(work: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    tenantId: TENANT,
    userId: USER,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'read-only-tenant',
    permissionVersion: 1,
    locale: 'en',
  };
  return runWithContext(context, work);
}

/** The status the tenant's own row carries, which is what the writer reads. */
async function setStatus(status: string): Promise<void> {
  await owner.tenant.update({ where: { id: TENANT }, data: { status: status as never } });
}

/** An ordinary audited change, standing in for the eighteen resources that make one. */
function anAuditedChange(): Promise<void> {
  return as(() =>
    writer.write(async () => {
      await Promise.resolve();
      return {
        result: undefined,
        change: {
          action: 'ORG_CHANGED',
          subjectType: AuditSubjectType.CONFIGURATION,
          subjectId: asId<AnyId>(TENANT),
          operation: AdministrativeOperation.UPDATED,
          after: { probe: true },
        },
      };
    }),
  );
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  const appConfig = {
    env: 'test',
    database: { url: APP_URL, poolSize: 5 },
    search: { recentLimit: 10 },
  } as unknown as AppConfig;

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `ro-${String(Date.now())}-${TENANT.slice(0, 8)}`,
      name: 'Read-only Tenant Test',
      status: TenantStatus.ACTIVE,
    },
  });
  await owner.user.create({
    data: {
      id: USER,
      tenantId: TENANT,
      email: `${USER}@example.test`,
      emailNormalized: `${USER}@example.test`,
      displayName: 'Test User',
      status: 'ACTIVE',
      updatedAt: FIXED_NOW,
    },
  });

  const unitOfWork = new PrismaUnitOfWork(sharedDatabase(appConfig, logger, APP_URL));
  const stack = realWriteStack(clock, unitOfWork);
  writer = stack.writer;
  definitions = new ReportDefinitionService(
    new PrismaReportDefinitionRepository(stack.stamps),
    writer,
  );
  searches = new SavedSearchService(
    new PrismaSavedSearchRepository(stack.stamps),
    new PrismaRecentSearchRepository(),
    appConfig,
    writer,
  );
  suppressions = new PrismaNotificationSuppressionRepository();
  notifications = new NotificationAdminService(
    new PrismaNotificationPreferenceRepository(),
    new PrismaNotificationTemplateRepository(),
    suppressions,
    {
      get: (definition: { defaultValue: unknown }) => Promise.resolve(definition.defaultValue),
    } as never,
    writer,
  );
}, 60_000);

afterEach(async () => {
  await setStatus(TenantStatus.ACTIVE);
});

afterAll(async () => {
  await owner?.$disconnect();
});

describe('a suspended tenant', () => {
  it('still accepts an audited change while it is active', async () => {
    await expect(anAuditedChange()).resolves.toBeUndefined();
  });

  it('refuses an audited change', async () => {
    await setStatus(TenantStatus.SUSPENDED);
    await expect(anAuditedChange()).rejects.toBeInstanceOf(TenantReadOnlyError);
  });

  it('still answers reads, because suspension is not a blackout', async () => {
    await setStatus(TenantStatus.SUSPENDED);
    await expect(as(() => searches.list())).resolves.toEqual([]);
    await expect(
      as(() => definitions.listForCaller({ page: 1, pageSize: 10 })),
    ).resolves.toMatchObject({ data: [] });
  });

  it('refuses a saved search', async () => {
    await setStatus(TenantStatus.SUSPENDED);
    await expect(
      as(() => searches.create({ name: 'Mine', query: 'iso', filters: {} })),
    ).rejects.toBeInstanceOf(TenantReadOnlyError);
    expect(await owner.savedSearch.count({ where: { tenantId: TENANT } })).toBe(0);
  });

  /**
   * The refusal comes *first*, which is an ordering rather than a detail.
   *
   * A suspended organisation is told it is read-only, not told its request was malformed — and
   * the transaction does not go looking. Checking afterwards would still roll the write back
   * today, because everything these eleven call sites do is a database write; it would stop being
   * true the first time one of them touched storage or a provider before returning.
   */
  it('answers with the refusal before it does the work', async () => {
    await setStatus(TenantStatus.SUSPENDED);
    await expect(as(() => searches.remove(uuidv7(), undefined))).rejects.toBeInstanceOf(
      TenantReadOnlyError,
    );
    await expect(
      as(() => definitions.remove(asId<ReportDefinitionId>(uuidv7()))),
    ).rejects.toBeInstanceOf(TenantReadOnlyError);
  });

  it('refuses a rename and a removal of a saved search', async () => {
    const created = await as(() =>
      searches.create({ name: 'Renamable', query: 'iso', filters: {} }),
    );
    await setStatus(TenantStatus.SUSPENDED);

    await expect(
      as(() => searches.update(created.id, created.version, { name: 'Renamed' })),
    ).rejects.toBeInstanceOf(TenantReadOnlyError);
    await expect(as(() => searches.remove(created.id, created.version))).rejects.toBeInstanceOf(
      TenantReadOnlyError,
    );

    const row = await owner.savedSearch.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ name: 'Renamable', deletedAt: null });
  });

  it('refuses a saved report definition', async () => {
    await setStatus(TenantStatus.SUSPENDED);
    await expect(as(() => definitions.save('documents', 'Mine', {}))).rejects.toBeInstanceOf(
      TenantReadOnlyError,
    );
    expect(await owner.reportDefinition.count({ where: { tenantId: TENANT } })).toBe(0);
  });

  it('refuses a notification preference, and the quiet hours beside it', async () => {
    await setStatus(TenantStatus.SUSPENDED);
    await expect(
      as(() =>
        notifications.savePreference(USER, NotificationType.APPROVAL_TASK_ASSIGNED.key, {
          channels: [NotificationChannel.EMAIL],
          digest: DigestFrequency.DAILY,
        }),
      ),
    ).rejects.toBeInstanceOf(TenantReadOnlyError);
    await expect(
      as(() => notifications.clearPreference(USER, NotificationType.APPROVAL_TASK_ASSIGNED.key)),
    ).rejects.toBeInstanceOf(TenantReadOnlyError);
    await expect(
      as(() =>
        notifications.saveQuietHours(USER, { startMinute: 0, endMinute: 60, timezone: 'UTC' }),
      ),
    ).rejects.toBeInstanceOf(TenantReadOnlyError);

    expect(await owner.notificationPreference.count({ where: { tenantId: TENANT } })).toBe(0);
    expect(await owner.notificationQuietHours.count({ where: { tenantId: TENANT } })).toBe(0);
  });

  it('refuses an administrator lifting a suppression', async () => {
    await as(() =>
      writer.read(() =>
        suppressions.recordPermanentFailure('bounced@example.test', 'mailbox full', 1, FIXED_NOW),
      ),
    );
    await setStatus(TenantStatus.SUSPENDED);

    await expect(
      as(() => notifications.releaseSuppression('bounced@example.test')),
    ).rejects.toBeInstanceOf(TenantReadOnlyError);
    const held = await owner.notificationSuppression.findFirstOrThrow({
      where: { tenantId: TENANT, address: 'bounced@example.test' },
    });
    expect(held.suppressedAt).not.toBeNull();
  });

  /**
   * The boundary, from the other side — and the reason the refusal did not simply move onto
   * `read`.
   *
   * A suspended tenant's own bookkeeping has to keep running: the delivery pass recording a
   * bounce, the integrity sweep recording what it found, the audit stream advancing its cursor.
   * Refusing those would make suspension a way to lose data rather than a way to stop people
   * changing things, which is the opposite of what `08-permission-model.md` §4 asks for.
   */
  it('still lets the system record what happened to it', async () => {
    await setStatus(TenantStatus.SUSPENDED);
    await expect(
      as(() =>
        writer.read(() =>
          suppressions.recordPermanentFailure('system@example.test', 'mailbox full', 1, FIXED_NOW),
        ),
      ),
    ).resolves.toMatchObject({ bounceCount: 1 });
  });

  it('refuses the removal of a saved report definition', async () => {
    const saved = await as(() => definitions.save('documents', 'Removable', {}));
    await setStatus(TenantStatus.SUSPENDED);

    await expect(as(() => definitions.remove(saved.id))).rejects.toBeInstanceOf(
      TenantReadOnlyError,
    );
    expect(
      await owner.reportDefinition.findUniqueOrThrow({ where: { id: saved.id } }),
    ).toMatchObject({ deletedAt: null });
  });
});
