import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  Disposition,
  MetadataDataType,
  NumberSegmentKind,
  RetentionTrigger,
  RevisionLabelStyle,
  SequenceResetScope,
  Settings,
  type TenantId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { FakeCache } from '../../../testing/fake-ports';
import { realWriteStack } from '../../../testing/real-collaborators';
import { ConfigurationService } from '../application/configuration.service';
import { ConfigurationKind } from '../application/administration.ports';
import { NumberingAdminService } from '../application/numbering-admin.service';
import { SettingsAdminService } from '../application/settings-admin.service';
import { CachedSettingsReader } from '../infrastructure/cached-settings.reader';
import { PrismaConfigurationRepository } from '../infrastructure/prisma-configuration.repository';
import { PrismaTenantSettingsRepository } from '../infrastructure/prisma-tenant-settings.repository';
import { sharedDatabase } from '../../../testing/tenant-database';

/**
 * Tenant configuration, against a real PostgreSQL.
 *
 * The invariants here are mostly *cross-row*, which is exactly the class a repository double cannot be
 * trusted about: a rank being unique among live levels, a delete refusing because a document type
 * points at the row, a padding change refusing because a sequence exists, a category move rewriting a
 * subtree, and `jsonb_set` merging rather than replacing a settings bag.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const config = { env: 'test', database: { url: APP_URL, poolSize: 10 } } as unknown as AppConfig;
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const FIXED_NOW = new Date('2026-08-15T10:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const { stamps, outbox, writer } = realWriteStack(clock, unitOfWork);
const repository = new PrismaConfigurationRepository(stamps);
const config_ = new ConfigurationService(repository, outbox, writer);
const numbering = new NumberingAdminService(repository, outbox, writer);

const settingsRepository = new PrismaTenantSettingsRepository(prisma);
const cache = new FakeCache();
const settingsReader = new CachedSettingsReader(settingsRepository, cache, logger);
const settings = new SettingsAdminService(settingsRepository, settingsReader, outbox, writer);

const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

const TENANT = asId<TenantId>(uuidv7());
const ADMIN = asId<UserId>(uuidv7());

function contextFor(tenantId: TenantId): RequestContext {
  return {
    tenantId,
    userId: ADMIN,
    roles: ['TENANT_ADMIN'],
    permissions: [],
    sessionId: null,
    correlationId: 'configuration',
    permissionVersion: 1,
    locale: 'en',
  };
}

function asAdmin<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(TENANT), work);
}

/** A counter, not a uuid slice: `uuidv7` leads with its timestamp, so slices repeat within a run. */
let sequenceNumber = 0;
function uniqueCode(prefix: string): string {
  sequenceNumber += 1;
  return `${prefix}${String(sequenceNumber).padStart(3, '0')}`;
}

async function aRule(): Promise<{ id: string; version: number }> {
  const rule = await asAdmin(() =>
    numbering.create({
      key: uniqueCode('rule-').toLowerCase(),
      name: 'Rule',
      separator: '-',
      segments: [{ kind: NumberSegmentKind.SEQUENCE, padding: 4 }],
      resetScope: [SequenceResetScope.NEVER],
      reserveOnSubmit: true,
      strictGapless: false,
    }),
  );
  return { id: rule.id, version: rule.version };
}

async function aLevel(rank: number): Promise<{ id: string; version: number }> {
  const level = await asAdmin(() =>
    config_.createConfidentiality({
      code: uniqueCode('CL'),
      name: `Level ${String(rank)}`,
      rank,
      allowDownload: true,
      allowPrint: true,
      watermark: false,
      requireReason: false,
    }),
  );
  return { id: level.id, version: level.version };
}

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `config-${Date.now()}`,
      name: 'Configuration Test',
      status: 'ACTIVE',
    },
  });
});

afterAll(async () => {
  await owner.$disconnect();
  await prisma.disconnectAll();
});

describe('confidentiality levels', () => {
  it('refuses a second level at the same rank', async () => {
    const rank = 90;
    await aLevel(rank);

    // Rank is the level's identity to the product: workflow conditions compare it and audit-on-read is
    // triggered by it, so "more sensitive than" has to be a total order.
    await expect(aLevel(rank)).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('frees a rank on delete and refuses a restore that would collide on it', async () => {
    const first = await aLevel(70);
    await asAdmin(() => config_.delete(ConfigurationKind.CONFIDENTIALITY, first.id, first.version));

    // The partial index skips deleted rows, so the rank is available again.
    const second = await aLevel(70);
    expect(second.id).not.toBe(first.id);

    // And the restore is refused on the *rank*, not only on the code — both halves of its identity are
    // checked, which a code-only check would have missed.
    const deleted = await asAdmin(() => config_.getConfidentiality(first.id));
    await expect(
      asAdmin(() => config_.restore(ConfigurationKind.CONFIDENTIALITY, first.id, deleted.version)),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('lists in rank order by default, because a list out of order is unreadable', async () => {
    const page = await asAdmin(() =>
      config_.listConfidentiality({
        page: 1,
        pageSize: 100,
        sortDirection: 'asc',
        deleted: 'live',
      }),
    );
    const ranks = page.data.map((row) => row.rank);
    expect([...ranks]).toEqual([...ranks].sort((left, right) => left - right));
  });
});

describe('retention policies', () => {
  it('refuses a period on a policy that keeps records indefinitely', async () => {
    await expect(
      asAdmin(() =>
        config_.createRetention({
          code: uniqueCode('RT'),
          name: 'Forever',
          trigger: RetentionTrigger.ON_PUBLISH,
          periodMonths: 12,
          disposition: Disposition.RETAIN_FOREVER,
          reviewRequired: false,
        }),
      ),
      // The database holds this as a check constraint too. Reaching it would mean the service let a
      // contradiction through.
    ).rejects.toThrow();
  });

  it('refuses a disposition with no period, so nothing says “purge, eventually”', async () => {
    await expect(
      asAdmin(() =>
        config_.createRetention({
          code: uniqueCode('RT'),
          name: 'Immediate',
          trigger: RetentionTrigger.ON_DELETE,
          periodMonths: 0,
          disposition: Disposition.PURGE,
          reviewRequired: true,
        }),
      ),
    ).rejects.toThrow();
  });

  it('accepts a coherent policy', async () => {
    const policy = await asAdmin(() =>
      config_.createRetention({
        code: uniqueCode('RT'),
        name: 'Seven years after supersession',
        trigger: RetentionTrigger.ON_SUPERSEDE,
        periodMonths: 84,
        disposition: Disposition.REVIEW,
        reviewRequired: true,
      }),
    );
    expect(policy.periodMonths).toBe(84);
  });
});

describe('metadata fields', () => {
  it('refuses a choice field with no options, and options on a field that is not a choice', async () => {
    await expect(
      asAdmin(() =>
        config_.createMetadataField({
          key: uniqueCode('field-').toLowerCase(),
          name: 'Empty choice',
          dataType: MetadataDataType.SELECT,
          options: [],
          validation: {},
          isSearchable: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      asAdmin(() =>
        config_.createMetadataField({
          key: uniqueCode('field-').toLowerCase(),
          name: 'Text with options',
          dataType: MetadataDataType.TEXT,
          options: [{ value: 'a', label: 'A' }],
          validation: {},
          isSearchable: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses an invalid pattern at save time rather than at document time', async () => {
    // Stored, it would throw on every document that used the field — in front of an author who cannot
    // fix it.
    await expect(
      asAdmin(() =>
        config_.createMetadataField({
          key: uniqueCode('field-').toLowerCase(),
          name: 'Bad pattern',
          dataType: MetadataDataType.TEXT,
          options: [],
          validation: { pattern: '([unclosed' },
          isSearchable: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('round-trips options and validation through jsonb', async () => {
    const field = await asAdmin(() =>
      config_.createMetadataField({
        key: uniqueCode('field-').toLowerCase(),
        name: 'Market',
        dataType: MetadataDataType.SELECT,
        options: [
          { value: 'jo', label: 'Jordan' },
          { value: 'eg', label: 'Egypt' },
        ],
        validation: { minLength: 2, maxLength: 2 },
        isSearchable: true,
      }),
    );

    const read = await asAdmin(() => config_.getMetadataField(field.id));
    // Read back as an object, not a string containing JSON, and narrowed rather than cast.
    expect(read.options).toEqual([
      { value: 'jo', label: 'Jordan' },
      { value: 'eg', label: 'Egypt' },
    ]);
    expect(read.validation).toEqual({ minLength: 2, maxLength: 2 });
  });

  it('refuses two options sharing a stored value', async () => {
    await expect(
      asAdmin(() =>
        config_.createMetadataField({
          key: uniqueCode('field-').toLowerCase(),
          name: 'Ambiguous',
          dataType: MetadataDataType.SELECT,
          options: [
            { value: 'a', label: 'One' },
            { value: 'A', label: 'Two' },
          ],
          validation: {},
          isSearchable: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('document types', () => {
  async function aType(): Promise<{ id: string; version: number; fieldId: string }> {
    const rule = await aRule();
    const level = await aLevel(sequenceNumber + 10);
    const field = await asAdmin(() =>
      config_.createMetadataField({
        key: uniqueCode('field-').toLowerCase(),
        name: 'Reviewer',
        dataType: MetadataDataType.USER,
        options: [],
        validation: {},
        isSearchable: false,
      }),
    );

    const type = await asAdmin(() =>
      config_.createDocumentType({
        code: uniqueCode('DT'),
        name: 'Procedure',
        numberingRuleId: rule.id,
        defaultConfidentialityId: level.id,
        revisionLabelStyle: RevisionLabelStyle.NUMERIC,
        isActive: true,
        fields: [{ metadataFieldId: field.id, isRequired: true, sortOrder: 0, defaultValue: null }],
      }),
    );
    return { id: type.id, version: type.version, fieldId: field.id };
  }

  it('resolves every reference, and reads them back by name', async () => {
    const type = await aType();
    const read = await asAdmin(() => config_.getDocumentType(type.id));

    expect(read.numberingRuleName).toBe('Rule');
    expect(read.defaultConfidentialityName).toMatch(/^Level /);
    // Null means no approval is required, which is legitimate for a reference type.
    expect(read.workflowDefinitionId).toBeNull();
    expect(read.fields).toHaveLength(1);
    expect(read.fields[0]).toMatchObject({ isRequired: true, name: 'Reviewer' });
  });

  it('names a reference that does not exist rather than letting a foreign key do it', async () => {
    const level = await aLevel(sequenceNumber + 10);
    await expect(
      asAdmin(() =>
        config_.createDocumentType({
          code: uniqueCode('DT'),
          name: 'Dangling',
          numberingRuleId: uuidv7(),
          defaultConfidentialityId: level.id,
          revisionLabelStyle: RevisionLabelStyle.NUMERIC,
          isActive: true,
          fields: [],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'numberingRuleId' }],
    });
  });

  it('blocks deleting a level, a rule or a field a type still points at', async () => {
    const type = await aType();
    const read = await asAdmin(() => config_.getDocumentType(type.id));

    const level = await asAdmin(() => config_.getConfidentiality(read.defaultConfidentialityId));
    await expect(
      asAdmin(() => config_.delete(ConfigurationKind.CONFIDENTIALITY, level.id, level.version)),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'documentTypes', message: '1' }] });

    const rule = await asAdmin(() => numbering.get(read.numberingRuleId));
    await expect(asAdmin(() => numbering.delete(rule.id, rule.version))).rejects.toMatchObject({
      fieldErrors: [{ field: 'documentTypes', message: '1' }],
    });

    const field = await asAdmin(() => config_.getMetadataField(type.fieldId));
    await expect(
      asAdmin(() => config_.delete(ConfigurationKind.METADATA_FIELD, field.id, field.version)),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'documentTypes', message: '1' }] });
  });

  it('publishes a change so anything caching the policy reconsiders, and recomputes nothing', async () => {
    const type = await aType();
    await asAdmin(() => config_.updateDocumentType(type.id, { name: 'Renamed' }, type.version));

    const messages = await owner.outboxMessage.findMany({
      where: {
        tenantId: TENANT,
        aggregateId: type.id,
        eventType: 'administration.document-type-changed',
      },
      select: { payload: true },
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload).toMatchObject({
      documentTypeId: type.id,
      changedFields: ['name'],
    });
  });

  it('refuses the same field attached twice', async () => {
    const rule = await aRule();
    const level = await aLevel(sequenceNumber + 10);
    const field = await asAdmin(() =>
      config_.createMetadataField({
        key: uniqueCode('field-').toLowerCase(),
        name: 'Twice',
        dataType: MetadataDataType.TEXT,
        options: [],
        validation: {},
        isSearchable: true,
      }),
    );

    await expect(
      asAdmin(() =>
        config_.createDocumentType({
          code: uniqueCode('DT'),
          name: 'Doubled',
          numberingRuleId: rule.id,
          defaultConfidentialityId: level.id,
          revisionLabelStyle: RevisionLabelStyle.NUMERIC,
          isActive: true,
          fields: [
            { metadataFieldId: field.id, isRequired: true, sortOrder: 0, defaultValue: null },
            { metadataFieldId: field.id, isRequired: false, sortOrder: 1, defaultValue: null },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('categories', () => {
  async function aTree(): Promise<{
    root: string;
    child: string;
    grandchild: string;
    other: string;
  }> {
    const root = await asAdmin(() =>
      config_.createCategory({ code: uniqueCode('CT'), name: `Root ${String(sequenceNumber)}` }),
    );
    const child = await asAdmin(() =>
      config_.createCategory({
        parentId: root.id,
        code: uniqueCode('CT'),
        name: `Child ${String(sequenceNumber)}`,
      }),
    );
    const grandchild = await asAdmin(() =>
      config_.createCategory({
        parentId: child.id,
        code: uniqueCode('CT'),
        name: `Grandchild ${String(sequenceNumber)}`,
      }),
    );
    const other = await asAdmin(() =>
      config_.createCategory({ code: uniqueCode('CT'), name: `Other ${String(sequenceNumber)}` }),
    );
    return { root: root.id, child: child.id, grandchild: grandchild.id, other: other.id };
  }

  it('derives the path from the parent and rewrites the subtree on a move', async () => {
    const tree = await aTree();
    const child = await asAdmin(() => config_.getCategory(tree.child));

    await asAdmin(() => config_.moveCategory(tree.child, tree.other, child.version));

    const rows = await owner.category.findMany({
      where: { tenantId: TENANT, id: { in: [tree.child, tree.grandchild] } },
      select: { id: true, path: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row.path]));

    expect(byId.get(tree.child)).toBe(`${tree.other}.${tree.child}`);
    // The grandchild moved with its parent. Rewriting only the node would leave it pointing at an
    // ancestry that no longer exists.
    expect(byId.get(tree.grandchild)).toBe(`${tree.other}.${tree.child}.${tree.grandchild}`);
  });

  it('allows the same name under different parents and refuses it among siblings', async () => {
    const tree = await aTree();
    const shared = `Shared ${String(sequenceNumber)}`;

    await asAdmin(() =>
      config_.createCategory({ parentId: tree.root, code: uniqueCode('CT'), name: shared }),
    );
    // A different parent is a different set of siblings.
    await expect(
      asAdmin(() =>
        config_.createCategory({ parentId: tree.other, code: uniqueCode('CT'), name: shared }),
      ),
    ).resolves.toMatchObject({ name: shared });

    await expect(
      asAdmin(() =>
        config_.createCategory({
          parentId: tree.root,
          code: uniqueCode('CT'),
          name: shared.toUpperCase(),
        }),
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('constrains the roots too, where a null parent makes the sibling index blind', async () => {
    // NULLs are distinct to a unique index, so `(tenant, parent, lower(name))` does not constrain the
    // roots at all. The second, partial index is what covers them — and this is the case that would
    // have slipped through it.
    const name = `Root Unique ${String(sequenceNumber)}`;
    await asAdmin(() => config_.createCategory({ code: uniqueCode('CT'), name }));

    await expect(
      asAdmin(() => config_.createCategory({ code: uniqueCode('CT'), name })),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('refuses a move under its own descendant', async () => {
    const tree = await aTree();
    const root = await asAdmin(() => config_.getCategory(tree.root));

    await expect(
      asAdmin(() => config_.moveCategory(tree.root, tree.grandchild, root.version)),
    ).rejects.toMatchObject({
      fieldErrors: [{ field: 'parentId', message: 'PARENT_IS_DESCENDANT' }],
    });
  });

  it('refuses deleting a category that still has children', async () => {
    const tree = await aTree();
    const root = await asAdmin(() => config_.getCategory(tree.root));

    await expect(
      asAdmin(() => config_.delete(ConfigurationKind.CATEGORY, tree.root, root.version)),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'subCategories' }] });
  });
});

describe('numbering rules', () => {
  it('renders a stored rule’s sample from the same formatter a preview uses', async () => {
    const created = await asAdmin(() =>
      numbering.create({
        key: uniqueCode('rule-').toLowerCase(),
        name: 'Quality procedure',
        separator: '-',
        segments: [
          { kind: NumberSegmentKind.LITERAL, value: 'QMS' },
          { kind: NumberSegmentKind.YEAR, digits: 4 },
          { kind: NumberSegmentKind.SEQUENCE, padding: 4 },
        ],
        resetScope: [SequenceResetScope.YEARLY],
        reserveOnSubmit: true,
        strictGapless: false,
      }),
    );

    // The clock is frozen at 2026, and the preview counter is 42.
    expect(numbering.sampleFor(created)).toBe('QMS-2026-0042');
  });

  it('refuses a rule that cannot issue a number, naming every reason', async () => {
    // Caught rather than matched, so the reasons can be asserted as a set: an administrator building a
    // rule sees everything wrong with it at once rather than discovering the next problem after
    // fixing this one.
    try {
      await asAdmin(() =>
        numbering.create({
          key: uniqueCode('rule-').toLowerCase(),
          name: 'Broken',
          separator: '',
          segments: [
            { kind: NumberSegmentKind.ENTITY_CODE, optional: true },
            { kind: NumberSegmentKind.BRANCH_CODE, optional: true },
          ],
          resetScope: [SequenceResetScope.YEARLY],
          reserveOnSubmit: true,
          strictGapless: false,
        }),
      );
      expect.unreachable('an unusable rule must be refused');
    } catch (error) {
      const reasons = (error as { fieldErrors: { message: string }[] }).fieldErrors.map(
        (entry) => entry.message,
      );
      expect(new Set(reasons)).toEqual(
        new Set([
          'NO_SEQUENCE',
          'AMBIGUOUS_OPTIONAL_SEGMENTS',
          'OPTIONAL_WITHOUT_SEPARATOR',
          'RESET_SCOPE_WITHOUT_SEGMENT',
        ]),
      );
    }
  });

  it('freezes the padding once a series exists', async () => {
    const rule = await aRule();
    // A drawn sequence is what "already issued numbers" means. Phase 5 draws these; the row is what
    // makes the rule immutable in this respect, so it is written directly.
    await owner.numberSequence.create({
      data: {
        id: uuidv7(),
        tenantId: TENANT,
        numberingRuleId: rule.id,
        scopeKey: 'ALL',
        nextValue: 43n,
      },
    });

    const current = await asAdmin(() => numbering.get(rule.id));
    expect(current.sequenceCount).toBe(1);

    // Widening would give `0042` a second written form, `00042`, which is the same defect as reusing
    // it.
    await expect(
      asAdmin(() =>
        numbering.update(
          rule.id,
          { segments: [{ kind: NumberSegmentKind.SEQUENCE, padding: 6 }] },
          current.version,
        ),
      ),
    ).rejects.toMatchObject({ fieldErrors: [{ field: 'segments', message: 'PADDING_LOCKED' }] });

    // The same shape at the same padding is still accepted: it is the *width* that is frozen.
    await expect(
      asAdmin(() =>
        numbering.update(
          rule.id,
          { segments: [{ kind: NumberSegmentKind.SEQUENCE, padding: 4 }] },
          current.version,
        ),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a blind change to a rule’s shape', async () => {
    const rule = await aRule();
    await expect(
      asAdmin(() => numbering.update(rule.id, { separator: '/' }, undefined)),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('publishes a rule change, and never renumbers anything', async () => {
    const rule = await aRule();
    const current = await asAdmin(() => numbering.get(rule.id));
    await asAdmin(() => numbering.update(rule.id, { separator: '/' }, current.version));

    const messages = await owner.outboxMessage.findMany({
      where: {
        tenantId: TENANT,
        aggregateId: rule.id,
        eventType: 'administration.numbering-rule-changed',
      },
    });
    expect(messages).toHaveLength(1);
  });

  it('does not publish for a rename, which changes no number', async () => {
    const rule = await aRule();
    const current = await asAdmin(() => numbering.get(rule.id));
    await asAdmin(() => numbering.update(rule.id, { name: 'Renamed' }, current.version));

    const messages = await owner.outboxMessage.findMany({
      where: {
        tenantId: TENANT,
        aggregateId: rule.id,
        eventType: 'administration.numbering-rule-changed',
      },
    });
    expect(messages).toHaveLength(0);
  });
});

describe('settings', () => {
  it('resolves every declared setting, whether stored or not', async () => {
    const view = await asAdmin(() => settings.all());

    expect(view.data.map((row) => row.key)).toEqual(
      expect.arrayContaining([Settings.TIMEZONE.key, Settings.PASSWORD_MINIMUM_LENGTH.key]),
    );
    // Complete and valid, always: callers never branch on "was it set?".
    expect(view.data.every((row) => row.value !== undefined)).toBe(true);
  });

  it('describes each setting from the catalogue, so a screen needs no per-key mapping', async () => {
    const view = await asAdmin(() => settings.all());
    const byKey = new Map(view.data.map((row) => [row.key, row]));

    expect(byKey.get(Settings.DEFAULT_LOCALE.key)).toMatchObject({
      kind: 'choice',
      allowed: ['en', 'ar'],
    });
    expect(byKey.get(Settings.PASSWORD_MINIMUM_LENGTH.key)).toMatchObject({
      kind: 'integer',
      minimum: 8,
      maximum: 128,
    });
    expect(byKey.get(Settings.PASSWORD_FORBID_IDENTIFIERS.key)).toMatchObject({ kind: 'boolean' });
    expect(byKey.get(Settings.TIMEZONE.key)).toMatchObject({ kind: 'string' });
  });

  it('writes one key without disturbing another', async () => {
    await asAdmin(() => settings.set(Settings.TIMEZONE.key, 'Asia/Amman'));
    await asAdmin(() => settings.set(Settings.PASSWORD_MINIMUM_LENGTH.key, 16));

    // `jsonb_set` merges in the database. A read-modify-write of the whole bag would have dropped the
    // first change when the second was saved.
    const view = await asAdmin(() => settings.all());
    const byKey = new Map(view.data.map((row) => [row.key, row]));
    expect(byKey.get(Settings.TIMEZONE.key)?.value).toBe('Asia/Amman');
    expect(byKey.get(Settings.PASSWORD_MINIMUM_LENGTH.key)?.value).toBe(16);
  });

  it('rejects a value out of bounds rather than clamping it', async () => {
    // A stored 2 where the minimum is 8 is somebody's mistake, and honouring 8 silently would hide it.
    await expect(
      asAdmin(() => settings.set(Settings.PASSWORD_MINIMUM_LENGTH.key, 2)),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      asAdmin(() => settings.set(Settings.DEFAULT_LOCALE.key, 'fr')),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a key the catalogue does not declare', async () => {
    await expect(asAdmin(() => settings.set('made.up.key', 'x'))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('reports a setting as overridden only while the tenant stores one', async () => {
    await asAdmin(() => settings.set(Settings.SESSION_IDLE_TIMEOUT_MINUTES.key, 60));
    const set = await asAdmin(() => settings.all());
    expect(
      set.data.find((row) => row.key === Settings.SESSION_IDLE_TIMEOUT_MINUTES.key),
    ).toMatchObject({ value: 60, isOverridden: true });

    await asAdmin(() => settings.reset(Settings.SESSION_IDLE_TIMEOUT_MINUTES.key));
    const reset = await asAdmin(() => settings.all());
    // The override is removed rather than replaced by today's default, so the setting keeps tracking
    // the product's opinion.
    expect(
      reset.data.find((row) => row.key === Settings.SESSION_IDLE_TIMEOUT_MINUTES.key),
    ).toMatchObject({
      value: Settings.SESSION_IDLE_TIMEOUT_MINUTES.defaultValue,
      isOverridden: false,
    });
  });

  it('invalidates the cached reader, so the next read sees the new value', async () => {
    // Warm the cache with the old value first, or the assertion would pass without any invalidation.
    await asAdmin(() => settingsReader.get(Settings.TIMEZONE));
    await asAdmin(() => settings.set(Settings.TIMEZONE.key, 'Europe/London'));

    expect(await asAdmin(() => settingsReader.get(Settings.TIMEZONE))).toBe('Europe/London');
  });

  it('records the change without recording the whole bag', async () => {
    await asAdmin(() => settings.set(Settings.TIMEZONE.key, 'UTC'));

    const events = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'SETTING_CHANGED' },
      orderBy: { sequence: 'desc' },
      take: 1,
      select: { payload: true },
    });

    // The key and both values — enough to answer "who shortened the minimum password length" without
    // making the trail a second copy of the configuration.
    expect(events[0]?.payload).toMatchObject({
      operation: 'UPDATED',
      after: { key: Settings.TIMEZONE.key, value: 'UTC' },
    });
  });

  it('surfaces a stored key the catalogue no longer declares', async () => {
    // A setting quietly falling back is a tenant running on a configuration they did not choose, and
    // this screen is the only place that is visible.
    await owner.$executeRawUnsafe(
      `UPDATE "tenant" SET "settings" = jsonb_set("settings", '{legacy.removed}', '"x"'::jsonb, true) WHERE "id" = $1::uuid`,
      TENANT,
    );

    const view = await asAdmin(() => settings.all());
    expect(view.diagnostics.unrecognised).toContain('legacy.removed');
  });
});

/**
 * Two callers, each parked at a chosen boundary.
 *
 * Gated on an explicit marker rather than on "the turnstile is armed", so the ordinary setup this
 * suite performs through the same repository does not park itself, take ordinals no slot was armed
 * for, and leave the caller it does want to hold waiting for ever.
 */
class Turnstile<TMarker> {
  readonly arrivals: TMarker[] = [];
  readonly reached: Promise<void>[] = [];
  private readonly announce: (() => void)[] = [];
  private readonly admissions: Promise<void>[] = [];
  private readonly admits: (() => void)[] = [];

  arm(callers: number): number {
    const base = this.reached.length;
    for (let index = 0; index < callers; index += 1) {
      let arrive: () => void = () => undefined;
      this.reached.push(
        new Promise<void>((resolve) => {
          arrive = resolve;
        }),
      );
      this.announce.push(arrive);
      let admit: () => void = () => undefined;
      this.admissions.push(
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
      );
      this.admits.push(admit);
    }
    return base;
  }

  async park(marker: TMarker): Promise<void> {
    const ordinal = this.arrivals.length;
    this.arrivals.push(marker);
    this.announce[ordinal]?.();
    await this.admissions[ordinal];
  }

  release(ordinal: number): void {
    this.admits[ordinal]?.();
  }
}

/**
 * A category move rewrites the paths it read, and only those — Slice 69.
 *
 * The third and last tree in the product carrying this shape. Slice 67 repaired departments and
 * Slice 68 repaired library folders; `moveCategory` still reads its subtree, computes every
 * descendant's new path from that snapshot, and writes them back with the moved node's write
 * version-guarded and the descendants' writes unguarded — "its path is derived data this module
 * owns, not a field anybody edits, so there is no concurrent edit to lose to".
 *
 * There is one, and it is this same method: a move rewrites a descendant's `path` and re-parents
 * the node it was asked to move, so two moves inside one subtree are two writers of one row.
 *
 * Categories are **not** an ACL scope — `ScopeType` names no `CATEGORY`, and Slice 68's finding
 * that no chain resolver reads `category.path` still holds. What `path` decides here is the tree
 * itself: `categorySubtree` selects by path prefix, the depth ceiling is measured from it, and
 * `checkTreePlacement` refuses a cycle with `isAtOrBelow(parentPath, nodePath)` and nothing else.
 * A row whose `parent_id` and `path` name different parents is therefore carried by the wrong
 * subtree, left behind by its real one, and judged for cycles against an ancestry it does not have.
 *
 * The database cannot catch it: `category` carries no constraint tying `path` to `parent_id`.
 */
describe('a category move that rewrites a subtree it no longer owns', () => {
  const turnstile = new Turnstile<string>();
  /** Which move this test wants to stop at, between its snapshot and its writes. */
  let parkOn: string | null = null;

  class ParkingConfigurationRepository extends PrismaConfigurationRepository {
    override async moveCategory(
      input: Parameters<PrismaConfigurationRepository['moveCategory']>[0],
    ): Promise<void> {
      // Parked *here*: the service has already read the subtree and computed every new path, and
      // has written nothing. That is the window the snapshot is stale in.
      if (parkOn === `move:${input.id}`) {
        await turnstile.park(`move:${input.id}`);
      }
      return super.moveCategory(input);
    }
  }

  const parking = new ConfigurationService(
    new ParkingConfigurationRepository(stamps),
    outbox,
    writer,
  );

  /** `parent → child → grandchild` with a `sibling` beside the child, plus two roots to move to. */
  async function tree(): Promise<{
    parent: { id: string; version: number; path: string };
    child: { id: string; version: number; path: string };
    grandchild: { id: string; version: number; path: string };
    sibling: { id: string; version: number; path: string };
    destination: { id: string; version: number; path: string };
    elsewhere: { id: string; version: number; path: string };
  }> {
    const make = async (
      parentId: string | null,
      label: string,
    ): Promise<{ id: string; version: number; path: string }> => {
      const row = await asAdmin(() =>
        parking.createCategory({
          ...(parentId === null ? {} : { parentId }),
          code: uniqueCode('CT'),
          name: `${label} ${String(sequenceNumber)}`,
        }),
      );
      return { id: row.id, version: row.version, path: row.path };
    };
    const parent = await make(null, 'Parent');
    const child = await make(parent.id, 'Child');
    const grandchild = await make(child.id, 'Grandchild');
    const sibling = await make(parent.id, 'Sibling');
    const destination = await make(null, 'Destination');
    const elsewhere = await make(null, 'Elsewhere');
    return { parent, child, grandchild, sibling, destination, elsewhere };
  }

  async function rowOf(id: string): Promise<{ parentId: string | null; path: string }> {
    return owner.category.findUniqueOrThrow({
      where: { id },
      select: { parentId: true, path: true },
    });
  }

  /** Every live category whose path disagrees with the parent it actually points at. */
  async function categoriesDisagreeingWithTheirParent(): Promise<string[]> {
    const rows = await owner.category.findMany({
      where: { tenantId: TENANT, deletedAt: null },
      select: { id: true, parentId: true, path: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return rows
      .filter((row) => {
        const parent = row.parentId === null ? null : byId.get(row.parentId);
        return row.path !== (parent ? `${parent.path}.${row.id}` : row.id);
      })
      .map((row) => row.id);
  }

  it('moves a subtree when nothing contends', async () => {
    // The control. Without it every assertion below passes on a service that moves nothing.
    const { parent, child, grandchild, destination } = await tree();
    const moved = await asAdmin(() =>
      parking.moveCategory(parent.id, destination.id, parent.version),
    );

    expect(moved.path).toBe(`${destination.path}.${parent.id}`);
    expect((await rowOf(child.id)).path).toBe(`${moved.path}.${child.id}`);
    expect((await rowOf(grandchild.id)).path).toBe(`${moved.path}.${child.id}.${grandchild.id}`);
    expect(await categoriesDisagreeingWithTheirParent()).toEqual([]);
  });

  it('refuses to rewrite a descendant that moved out while it was deciding', async () => {
    const { parent, child, destination, elsewhere } = await tree();
    parkOn = `move:${parent.id}`;
    const base = turnstile.arm(1);

    // The first administrator moves the parent. Its subtree snapshot, taken before it parks, still
    // has the child under it.
    const movingParent = asAdmin(() =>
      parking.moveCategory(parent.id, destination.id, parent.version),
    );
    await turnstile.reached[base];
    expect(turnstile.arrivals.at(-1)).toBe(`move:${parent.id}`);

    // The second administrator moves the child out, from its own scope and so its own transaction,
    // and commits. This is the edit the first administrator's snapshot cannot know about.
    parkOn = null;
    const movedChild = await asAdmin(() =>
      parking.moveCategory(child.id, elsewhere.id, child.version),
    );
    expect(movedChild.path).toBe(`${elsewhere.path}.${child.id}`);

    turnstile.release(base);
    const outcome = await movingParent.then(
      () => ({ kind: 'moved' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    // Whatever the first move's own fate, the child must not be left describing an ancestry it does
    // not have: the path is what `categorySubtree` selects on and what the cycle check reads.
    const after = await rowOf(child.id);
    expect(after.parentId).toBe(elsewhere.id);
    expect(after.path).toBe(`${elsewhere.path}.${child.id}`);
    expect(after.path.split('.')).not.toContain(parent.id);
    expect(await categoriesDisagreeingWithTheirParent()).toEqual([]);

    // And the loser is told, rather than committing a rewrite of a tree that changed under it.
    expect(outcome.kind).toBe('refused');
    expect(outcome.error).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('refuses the second of two administrators moving the same category', async () => {
    /*
     * The moved node's own guard, which the descendants' guard sits on top of.
     *
     * The service refuses a *stale* version before the repository is reached, so this guard is only
     * ever exercised by a genuine race: both administrators read version `v`, both pass
     * `requireVersion`, and only the `WHERE version = v` on the write can make one of them lose.
     * Without it both moves report success and the first administrator's move is silently
     * overwritten by the second.
     */
    const { parent, destination, elsewhere } = await tree();
    parkOn = `move:${parent.id}`;
    const base = turnstile.arm(2);

    // Both read the same version, from their own scopes and so their own transactions.
    const first = asAdmin(() => parking.moveCategory(parent.id, destination.id, parent.version));
    await turnstile.reached[base];
    const second = asAdmin(() => parking.moveCategory(parent.id, elsewhere.id, parent.version));
    await turnstile.reached[base + 1];
    expect(turnstile.arrivals.slice(-2)).toEqual([`move:${parent.id}`, `move:${parent.id}`]);

    turnstile.release(base);
    const winner = await first.then(
      (value) => ({ kind: 'moved' as const, value, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, value: undefined, error }),
    );
    turnstile.release(base + 1);
    const loser = await second.then(
      () => ({ kind: 'moved' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    expect(winner.kind).toBe('moved');
    expect(loser.kind).toBe('refused');
    expect(loser.error).toMatchObject({ code: 'VERSION_CONFLICT' });
    // The winner's move stands whole, rather than half of each.
    expect((await rowOf(parent.id)).parentId).toBe(destination.id);
    expect((await rowOf(parent.id)).path).toBe(`${destination.path}.${parent.id}`);
    expect(await categoriesDisagreeingWithTheirParent()).toEqual([]);
  });

  it('refuses when a descendant only moved to another branch of the same subtree', async () => {
    /*
     * Why the guard refuses rather than quietly skipping the row it no longer recognises.
     *
     * The category that moved is still inside the subtree being moved, so the rest of the snapshot
     * is still wrong about it: the grandchild now hangs from the sibling, and the sibling's path is
     * about to be rewritten. Skipping the one row whose parent changed would rewrite the sibling and
     * leave the grandchild describing where the sibling used to be — the same divergence, one level
     * further down. The whole snapshot is stale together, so the whole move is refused together.
     */
    const { parent, child, grandchild, sibling, destination } = await tree();
    parkOn = `move:${parent.id}`;
    const base = turnstile.arm(1);

    const movingParent = asAdmin(() =>
      parking.moveCategory(parent.id, destination.id, parent.version),
    );
    await turnstile.reached[base];

    parkOn = null;
    const moved = await asAdmin(() =>
      parking.moveCategory(grandchild.id, sibling.id, grandchild.version),
    );
    expect(moved.path).toBe(`${sibling.path}.${grandchild.id}`);

    turnstile.release(base);
    const outcome = await movingParent.then(
      () => ({ kind: 'moved' as const, error: undefined }),
      (error: unknown) => ({ kind: 'refused' as const, error }),
    );

    expect(outcome.kind).toBe('refused');
    expect(outcome.error).toMatchObject({ code: 'VERSION_CONFLICT' });
    // Refused means nothing was written, so the sibling still holds the path the grandchild names.
    expect((await rowOf(child.id)).path).toBe(`${parent.path}.${child.id}`);
    expect((await rowOf(sibling.id)).path).toBe(`${parent.path}.${sibling.id}`);
    expect(await categoriesDisagreeingWithTheirParent()).toEqual([]);
  });

  it('still moves when a descendant was only put in the recycle bin', async () => {
    /*
     * The other side of the guard: what must *not* become a conflict.
     *
     * Deleting a leaf moves nothing, so the snapshot is still right about where every category sits
     * and the move has nothing to lose to. The deleted row is carried along with the rest —
     * `categorySubtree` never sees a row already in the bin, so restoring one whose ancestors moved
     * meanwhile is a stale path either way, and this is the one window where the move can still
     * keep it honest.
     */
    const { parent, child, grandchild, destination } = await tree();
    parkOn = `move:${parent.id}`;
    const base = turnstile.arm(1);

    const movingParent = asAdmin(() =>
      parking.moveCategory(parent.id, destination.id, parent.version),
    );
    await turnstile.reached[base];

    parkOn = null;
    await asAdmin(() =>
      parking.delete(ConfigurationKind.CATEGORY, grandchild.id, grandchild.version),
    );

    turnstile.release(base);
    const moved = await movingParent;

    expect(moved.path).toBe(`${destination.path}.${parent.id}`);
    const movedChild = await rowOf(child.id);
    expect(movedChild.path).toBe(`${moved.path}.${child.id}`);
    // Carried with the subtree even though it is in the bin, so a restore does not resurrect a row
    // describing where its ancestors used to be.
    expect((await rowOf(grandchild.id)).path).toBe(`${movedChild.path}.${grandchild.id}`);
    expect(await categoriesDisagreeingWithTheirParent()).toEqual([]);
  });
});
