import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { SequenceResetScopeKey } from '@edms/domain';
import { ancestorIdsOf, subtreePrefix } from '@edms/domain';
import { type Page, toPage } from '@edms/utils';

import { DuplicateError, VersionConflictError } from '../../../core/errors/application-errors';
import {
  RecordStamps,
  deletedCondition,
  orderByFor,
  pageArgs,
  searchConditions,
} from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type { NumberSegment } from '../domain/numbering';
import {
  type CategoryListRequest,
  type CategoryRow,
  type ConfidentialityLevelRow,
  type ConfigListRequest,
  ConfigurationKind,
  type ConfigurationKindKey,
  type ConfigurationRepository,
  type DocumentTypeListRequest,
  type DocumentTypeRow,
  type MetadataFieldListRequest,
  type MetadataFieldRow,
  type MetadataOption,
  type MetadataValidation,
  type NumberingRuleRow,
  type RetentionListRequest,
  type RetentionPolicyRow,
  type SubtreeNode,
  type TypeField,
} from '../application/administration.ports';

/**
 * Tenant configuration, in the database.
 *
 * Every update is guarded by the version in its `WHERE`, every count comes from `_count` rather than
 * from loading children, and every read filters the tenant explicitly as well as relying on row-level
 * security — the same three habits as the organisation repository, for the same three reasons.
 *
 * The one thing peculiar to this file is the `jsonb` columns. `segments`, `options` and `validation`
 * are read back as `Prisma.JsonValue` and are narrowed by the mappers at the bottom rather than cast:
 * a row written by an older release, or edited by hand, must not reach a formatter as a shape it
 * cannot render.
 */
/**
 * What a caller can collide on, per configuration kind — Slice 111.
 *
 * Every write below reaches a unique index after a `…Taken` read that is already a moment old, so
 * the loser of two administrators typing the same code meets `P2002` rather than the refusal the
 * second-comer gets a second later. Slice 63 settled how that is repaired: *translate* rather than
 * tolerate, because a unique violation aborts the transaction and a loser that needed to read
 * could not recover — "they need a different exception, and the boundary that knows what the index
 * means is where it belongs". `PrismaIdentityAdminRepository.claimingUnique` is that boundary for
 * `user` and `role`; this is the same boundary for the administration kinds.
 *
 * **Only the kinds whose answer is determined.** Prisma reports `P2002` for these indexes with
 * `meta.target` null — the model, and nothing about which index was hit. That is enough for a kind
 * with one collidable index and not enough for one with several: a confidentiality level can
 * collide on its code or on its rank, a category on its code or its sibling name, a working
 * calendar on three. Naming one of those in the refusal would be guessing at which, so those kinds
 * are absent here and their losers keep the error they had. What the caller should be told when the
 * index is ambiguous is a product decision, not this repository's to make.
 */
const CLAIMS: Readonly<
  Partial<Record<ConfigurationKindKey, { model: string; resource: string; field: string }>>
> = Object.freeze({
  [ConfigurationKind.RETENTION]: {
    model: 'RetentionPolicy',
    resource: 'retention policy',
    field: 'code',
  },
  [ConfigurationKind.METADATA_FIELD]: {
    model: 'MetadataField',
    resource: 'metadata field',
    field: 'key',
  },
  [ConfigurationKind.DOCUMENT_TYPE]: {
    model: 'DocumentType',
    resource: 'document type',
    field: 'code',
  },
  [ConfigurationKind.NUMBERING_RULE]: {
    model: 'NumberingRule',
    resource: 'numbering rule',
    field: 'key',
  },
});

/**
 * A unique violation on one named model, and nothing else.
 *
 * The model matters: a write that touches a parent and its children can raise `P2002` from either,
 * and a translation that ignored which would rename somebody else's collision.
 */
export function isUniqueViolationOn(error: unknown, model: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    error.meta?.['modelName'] === model
  );
}

@Injectable()
export class PrismaConfigurationRepository implements ConfigurationRepository {
  constructor(private readonly stamps: RecordStamps) {}

  // --- Confidentiality levels ------------------------------------------------------------

  async listConfidentiality(request: ConfigListRequest): Promise<Page<ConfidentialityLevelRow>> {
    const tx = requireTransaction();
    const where: Prisma.ConfidentialityLevelWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      OR: searchConditions(request.search, ['name', 'code', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.confidentialityLevel.findMany({
        where,
        // Rank ascending by default: a list of sensitivity levels out of order is a list nobody can
        // read, whatever the generic default sort says.
        orderBy: orderByFor(request.sortBy as 'rank' | undefined, request.sortDirection, 'rank'),
        ...pageArgs(request),
        include: { _count: { select: { documentTypes: { where: { deletedAt: null } } } } },
      }),
      tx.confidentialityLevel.count({ where }),
    ]);

    return toPage(rows.map(toConfidentiality), total, request);
  }

  async findConfidentiality(
    id: string,
    includeDeleted: boolean,
  ): Promise<ConfidentialityLevelRow | null> {
    const row = await requireTransaction().confidentialityLevel.findFirst({
      where: this.identity(id, includeDeleted),
      include: { _count: { select: { documentTypes: { where: { deletedAt: null } } } } },
    });
    return row ? toConfidentiality(row) : null;
  }

  confidentialityCodeTaken(code: string, exceptId: string | null): Promise<boolean> {
    return this.codeTaken('confidentialityLevel', 'code', code, exceptId);
  }

  async confidentialityRankTaken(rank: number, exceptId: string | null): Promise<boolean> {
    const found = await requireTransaction().confidentialityLevel.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        rank,
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertConfidentiality(input: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    rank: number;
    allowDownload: boolean;
    allowPrint: boolean;
    watermark: boolean;
    requireReason: boolean;
  }): Promise<void> {
    await requireTransaction().confidentialityLevel.create({
      data: { ...input, tenantId: this.tenantId(), ...this.stamps.creation() },
    });
  }

  async updateConfidentiality(
    id: string,
    version: number,
    patch: Prisma.ConfidentialityLevelUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await requireTransaction().confidentialityLevel.updateMany({
      where: { id, tenantId: this.tenantId(), version, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  // --- Retention policies ----------------------------------------------------------------

  async listRetention(request: RetentionListRequest): Promise<Page<RetentionPolicyRow>> {
    const tx = requireTransaction();
    const where: Prisma.RetentionPolicyWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.trigger !== undefined && { trigger: request.trigger }),
      ...(request.disposition !== undefined && { disposition: request.disposition }),
      OR: searchConditions(request.search, ['name', 'code', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.retentionPolicy.findMany({
        where,
        orderBy: orderByFor(request.sortBy as 'name' | undefined, request.sortDirection, 'name'),
        ...pageArgs(request),
        include: { _count: { select: { documentTypes: { where: { deletedAt: null } } } } },
      }),
      tx.retentionPolicy.count({ where }),
    ]);

    return toPage(rows.map(toRetention), total, request);
  }

  async findRetention(id: string, includeDeleted: boolean): Promise<RetentionPolicyRow | null> {
    const row = await requireTransaction().retentionPolicy.findFirst({
      where: this.identity(id, includeDeleted),
      include: { _count: { select: { documentTypes: { where: { deletedAt: null } } } } },
    });
    return row ? toRetention(row) : null;
  }

  retentionCodeTaken(code: string, exceptId: string | null): Promise<boolean> {
    return this.codeTaken('retentionPolicy', 'code', code, exceptId);
  }

  async insertRetention(input: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    trigger: RetentionPolicyRow['trigger'];
    periodMonths: number;
    disposition: RetentionPolicyRow['disposition'];
    reviewRequired: boolean;
  }): Promise<void> {
    return this.claimingUnique(ConfigurationKind.RETENTION, async () => {
      await requireTransaction().retentionPolicy.create({
        data: { ...input, tenantId: this.tenantId(), ...this.stamps.creation() },
      });
    });
  }

  async updateRetention(
    id: string,
    version: number,
    patch: Prisma.RetentionPolicyUpdateManyMutationInput,
  ): Promise<void> {
    return this.claimingUnique(ConfigurationKind.RETENTION, async () => {
      const { count } = await requireTransaction().retentionPolicy.updateMany({
        where: { id, tenantId: this.tenantId(), version, deletedAt: null },
        data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
      });
      this.requireOneRow(count, version);
    });
  }

  // --- Categories ------------------------------------------------------------------------

  async listCategories(request: CategoryListRequest): Promise<Page<CategoryRow>> {
    const tx = requireTransaction();
    const where: Prisma.CategoryWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.parentId !== undefined && {
        parentId: request.parentId === 'null' ? null : request.parentId,
      }),
      ...(await this.categoryUnder(request.underId)),
      OR: searchConditions(request.search, ['name', 'code', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.category.findMany({
        where,
        // Path order, so a flat list reads as a tree: a child follows its parent.
        orderBy: orderByFor(request.sortBy as 'path' | undefined, request.sortDirection, 'path'),
        ...pageArgs(request),
        include: { _count: { select: { children: { where: { deletedAt: null } } } } },
      }),
      tx.category.count({ where }),
    ]);

    return toPage(rows.map(toCategory), total, request);
  }

  async findCategory(id: string, includeDeleted: boolean): Promise<CategoryRow | null> {
    const row = await requireTransaction().category.findFirst({
      where: this.identity(id, includeDeleted),
      include: { _count: { select: { children: { where: { deletedAt: null } } } } },
    });
    return row ? toCategory(row) : null;
  }

  categoryCodeTaken(code: string, exceptId: string | null): Promise<boolean> {
    return this.codeTaken('category', 'code', code, exceptId);
  }

  async categorySiblingNameTaken(
    parentId: string | null,
    name: string,
    exceptId: string | null,
  ): Promise<boolean> {
    const found = await requireTransaction().category.findFirst({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        parentId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId !== null && { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    return found !== null;
  }

  async insertCategory(input: {
    id: string;
    parentId: string | null;
    code: string;
    name: string;
    description: string | null;
    path: string;
  }): Promise<void> {
    await requireTransaction().category.create({
      data: { ...input, tenantId: this.tenantId(), ...this.stamps.creation() },
    });
  }

  async updateCategory(
    id: string,
    version: number,
    patch: Prisma.CategoryUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await requireTransaction().category.updateMany({
      where: { id, tenantId: this.tenantId(), version, deletedAt: null },
      data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
    });
    this.requireOneRow(count, version);
  }

  async placeCategory(id: string, path: string): Promise<void> {
    // No version in the guard: the caller has just claimed this row by its version in the same
    // transaction (`setDeleted`), so there is nothing else it can be. `deleted_at: null` is, so this
    // only ever places a row the restore has already brought back.
    const { count } = await requireTransaction().category.updateMany({
      where: { id, tenantId: this.tenantId(), deletedAt: null },
      data: { path },
    });
    if (count !== 1) {
      throw new Error('The restored category was not there to place.');
    }
  }

  async categorySubtree(path: string): Promise<readonly SubtreeNode[]> {
    return requireTransaction().category.findMany({
      where: {
        tenantId: this.tenantId(),
        deletedAt: null,
        OR: [{ path }, { path: { startsWith: subtreePrefix(path) } }],
      },
      select: { id: true, path: true },
    });
  }

  async moveCategory(input: {
    id: string;
    version: number;
    parentId: string | null;
    paths: readonly SubtreeNode[];
  }): Promise<void> {
    const tx = requireTransaction();
    const stamps = this.stamps.update();
    const own = input.paths.find((node) => node.id === input.id);
    if (!own) {
      // The subtree was computed from this node's own path, so it always contains it. Writing a
      // partial move would corrupt the tree.
      throw new Error('The rewritten subtree does not contain the category being moved.');
    }

    const { count } = await tx.category.updateMany({
      where: { id: input.id, tenantId: this.tenantId(), version: input.version, deletedAt: null },
      data: { parentId: input.parentId, path: own.path, ...stamps, version: { increment: 1 } },
    });
    this.requireOneRow(count, input.version);

    /*
     * Then the descendants, **each guarded by the parent the snapshot found it under** — Slice 69.
     *
     * There *is* a concurrent edit to lose to, and it is this same method: a move rewrites a
     * descendant's `path` and re-parents the node it was asked to move, so two moves inside one
     * subtree are two writers of one row. The second mover's version guard protects the node it
     * acted on; nothing protected that node from the first mover's rewrite of it as somebody else's
     * descendant, and the row that came out named one parent in `parent_id` and another in `path`.
     *
     * Categories are not an ACL scope, so unlike the department and folder trees this decides no
     * permission. It decides the tree: `categorySubtree` selects by path prefix, the depth ceiling
     * is measured from the path, and `checkTreePlacement` refuses a cycle with
     * `isAtOrBelow(parentPath, nodePath)` and nothing else — so a diverged row is carried by the
     * wrong subtree, left behind by its real one, and judged for cycles against an ancestry it does
     * not have. `category` carries no constraint tying `path` to `parent_id`.
     *
     * Guarded on `parent_id` rather than on the version: a descendant that was merely renamed has a
     * new version and the same place in the tree, and refusing a move because somebody edited a name
     * would be a conflict about nothing. Zero rows means the tree moved under the snapshot, which is
     * a `VersionConflictError` for the same reason the moved node's own guard is — and a refusal
     * rather than a skip, because skipping only the row whose parent changed would rewrite its
     * siblings and leave it describing where one of them used to be.
     *
     * `deleted_at` is deliberately not in the guard. The snapshot only ever contains live rows, so
     * the only row this can now reach that it could not before is one soft-deleted since, and
     * rewriting that one is what keeps its path usable if it is restored.
     *
     * What this does not close: a category created under, or moved *into*, this subtree while the
     * move is deciding is not in the snapshot, so no statement here guards it. The arrival writes
     * only its own row — measured, its foreign key takes `FOR KEY SHARE` on the parent, which does
     * not conflict with this rewrite's `FOR NO KEY UPDATE` — so closing it needs the arrival to
     * write its new parent's row, which changes what `version` means on a parent.
     */
    for (const node of input.paths) {
      if (node.id === input.id) {
        continue;
      }
      const { count: rewritten } = await tx.category.updateMany({
        where: { id: node.id, tenantId: this.tenantId(), parentId: parentIdIn(node.path) },
        data: { path: node.path, ...stamps },
      });
      this.requireOneRow(rewritten, input.version);
    }
  }

  // --- Metadata fields -------------------------------------------------------------------

  async listMetadataFields(request: MetadataFieldListRequest): Promise<Page<MetadataFieldRow>> {
    const tx = requireTransaction();
    const where: Prisma.MetadataFieldWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.dataType !== undefined && { dataType: request.dataType }),
      OR: searchConditions(request.search, ['name', 'key', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.metadataField.findMany({
        where,
        orderBy: orderByFor(request.sortBy as 'name' | undefined, request.sortDirection, 'name'),
        ...pageArgs(request),
        include: { _count: { select: { documentTypes: true } } },
      }),
      tx.metadataField.count({ where }),
    ]);

    return toPage(rows.map(toMetadataField), total, request);
  }

  async findMetadataField(id: string, includeDeleted: boolean): Promise<MetadataFieldRow | null> {
    const row = await requireTransaction().metadataField.findFirst({
      where: this.identity(id, includeDeleted),
      include: { _count: { select: { documentTypes: true } } },
    });
    return row ? toMetadataField(row) : null;
  }

  metadataFieldKeyTaken(key: string, exceptId: string | null): Promise<boolean> {
    return this.codeTaken('metadataField', 'key', key, exceptId);
  }

  async insertMetadataField(input: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    dataType: MetadataFieldRow['dataType'];
    options: readonly MetadataOption[];
    validation: MetadataValidation;
    isSearchable: boolean;
  }): Promise<void> {
    return this.claimingUnique(ConfigurationKind.METADATA_FIELD, async () => {
      await requireTransaction().metadataField.create({
        data: {
          ...input,
          // Spread into a mutable array and object: Prisma's `InputJsonValue` is not satisfied by a
          // `readonly` type, and casting instead would hide a genuine mismatch if the shape changed.
          options: [...input.options],
          validation: { ...input.validation },
          tenantId: this.tenantId(),
          ...this.stamps.creation(),
        },
      });
    });
  }

  async updateMetadataField(
    id: string,
    version: number,
    patch: {
      name?: string;
      description?: string | null;
      options?: readonly MetadataOption[];
      validation?: MetadataValidation;
      isSearchable?: boolean;
    },
  ): Promise<void> {
    return this.claimingUnique(ConfigurationKind.METADATA_FIELD, async () => {
      const { count } = await requireTransaction().metadataField.updateMany({
        where: { id, tenantId: this.tenantId(), version, deletedAt: null },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.options !== undefined && { options: [...patch.options] }),
          ...(patch.validation !== undefined && { validation: { ...patch.validation } }),
          ...(patch.isSearchable !== undefined && { isSearchable: patch.isSearchable }),
          ...this.stamps.update(),
          version: { increment: 1 },
        },
      });
      this.requireOneRow(count, version);
    });
  }

  // --- Document types --------------------------------------------------------------------

  async listDocumentTypes(request: DocumentTypeListRequest): Promise<Page<DocumentTypeRow>> {
    const tx = requireTransaction();
    const where: Prisma.DocumentTypeWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      ...(request.isActive !== undefined && { isActive: request.isActive }),
      ...(request.workflowDefinitionId !== undefined && {
        workflowDefinitionId: request.workflowDefinitionId,
      }),
      ...(request.retentionPolicyId !== undefined && {
        retentionPolicyId: request.retentionPolicyId,
      }),
      OR: searchConditions(request.search, ['name', 'code', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.documentType.findMany({
        where,
        orderBy: orderByFor(request.sortBy as 'name' | undefined, request.sortDirection, 'name'),
        ...pageArgs(request),
        include: DOCUMENT_TYPE_RELATIONS,
      }),
      tx.documentType.count({ where }),
    ]);

    return toPage(rows.map(toDocumentType), total, request);
  }

  async findDocumentType(id: string, includeDeleted: boolean): Promise<DocumentTypeRow | null> {
    const row = await requireTransaction().documentType.findFirst({
      where: this.identity(id, includeDeleted),
      include: DOCUMENT_TYPE_RELATIONS,
    });
    return row ? toDocumentType(row) : null;
  }

  documentTypeCodeTaken(code: string, exceptId: string | null): Promise<boolean> {
    return this.codeTaken('documentType', 'code', code, exceptId);
  }

  async insertDocumentType(input: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    numberingRuleId: string;
    workflowDefinitionId: string | null;
    retentionPolicyId: string | null;
    defaultConfidentialityId: string;
    revisionLabelStyle: DocumentTypeRow['revisionLabelStyle'];
    isActive: boolean;
  }): Promise<void> {
    return this.claimingUnique(ConfigurationKind.DOCUMENT_TYPE, async () => {
      await requireTransaction().documentType.create({
        data: { ...input, tenantId: this.tenantId(), ...this.stamps.creation() },
      });
    });
  }

  async updateDocumentType(
    id: string,
    version: number,
    patch: Prisma.DocumentTypeUpdateManyMutationInput,
  ): Promise<void> {
    return this.claimingUnique(ConfigurationKind.DOCUMENT_TYPE, async () => {
      const { count } = await requireTransaction().documentType.updateMany({
        where: { id, tenantId: this.tenantId(), version, deletedAt: null },
        data: { ...patch, ...this.stamps.update(), version: { increment: 1 } },
      });
      this.requireOneRow(count, version);
    });
  }

  async replaceTypeFields(documentTypeId: string, fields: readonly TypeField[]): Promise<void> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    // Replaced rather than diffed: a diff would be a second place that decides which field is
    // required, and the join's primary key would then be enforcing a rule two pieces of code disagree
    // about.
    await tx.typeMetadataField.deleteMany({ where: { tenantId, documentTypeId } });
    if (fields.length === 0) {
      return;
    }
    await tx.typeMetadataField.createMany({
      data: fields.map((field) => ({
        tenantId,
        documentTypeId,
        metadataFieldId: field.metadataFieldId,
        isRequired: field.isRequired,
        sortOrder: field.sortOrder,
        defaultValue: field.defaultValue,
      })),
    });
  }

  // --- Numbering rules -------------------------------------------------------------------

  async listNumberingRules(request: ConfigListRequest): Promise<Page<NumberingRuleRow>> {
    const tx = requireTransaction();
    const where: Prisma.NumberingRuleWhereInput = {
      tenantId: this.tenantId(),
      deletedAt: deletedCondition(request.deleted),
      OR: searchConditions(request.search, ['name', 'key', 'description']),
    };

    const [rows, total] = await Promise.all([
      tx.numberingRule.findMany({
        where,
        orderBy: orderByFor(request.sortBy as 'name' | undefined, request.sortDirection, 'name'),
        ...pageArgs(request),
        include: {
          // Sequences are never soft-deleted — a counter that came back from a recycle bin would
          // re-issue numbers — so there is no `deletedAt` filter to apply here.
          _count: { select: { sequences: true, documentTypes: { where: { deletedAt: null } } } },
        },
      }),
      tx.numberingRule.count({ where }),
    ]);

    return toPage(rows.map(toNumberingRule), total, request);
  }

  async findNumberingRule(id: string, includeDeleted: boolean): Promise<NumberingRuleRow | null> {
    const row = await requireTransaction().numberingRule.findFirst({
      where: this.identity(id, includeDeleted),
      include: {
        _count: { select: { sequences: true, documentTypes: { where: { deletedAt: null } } } },
      },
    });
    return row ? toNumberingRule(row) : null;
  }

  numberingRuleKeyTaken(key: string, exceptId: string | null): Promise<boolean> {
    return this.codeTaken('numberingRule', 'key', key, exceptId);
  }

  async insertNumberingRule(input: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    separator: string;
    segments: readonly NumberSegment[];
    resetScope: readonly SequenceResetScopeKey[];
    reserveOnSubmit: boolean;
    strictGapless: boolean;
  }): Promise<void> {
    return this.claimingUnique(ConfigurationKind.NUMBERING_RULE, async () => {
      await requireTransaction().numberingRule.create({
        data: {
          ...input,
          segments: [...input.segments],
          resetScope: [...input.resetScope],
          tenantId: this.tenantId(),
          ...this.stamps.creation(),
        },
      });
    });
  }

  async updateNumberingRule(
    id: string,
    version: number,
    patch: {
      key?: string;
      name?: string;
      description?: string | null;
      separator?: string;
      segments?: readonly NumberSegment[];
      resetScope?: readonly SequenceResetScopeKey[];
      reserveOnSubmit?: boolean;
      strictGapless?: boolean;
    },
  ): Promise<void> {
    return this.claimingUnique(ConfigurationKind.NUMBERING_RULE, async () => {
      const { count } = await requireTransaction().numberingRule.updateMany({
        where: { id, tenantId: this.tenantId(), version, deletedAt: null },
        data: {
          ...(patch.key !== undefined && { key: patch.key }),
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.separator !== undefined && { separator: patch.separator }),
          ...(patch.segments !== undefined && { segments: [...patch.segments] }),
          ...(patch.resetScope !== undefined && { resetScope: [...patch.resetScope] }),
          ...(patch.reserveOnSubmit !== undefined && { reserveOnSubmit: patch.reserveOnSubmit }),
          ...(patch.strictGapless !== undefined && { strictGapless: patch.strictGapless }),
          ...this.stamps.update(),
          version: { increment: 1 },
        },
      });
      this.requireOneRow(count, version);
    });
  }

  // --- Shared ----------------------------------------------------------------------------

  async setDeleted(
    kind: ConfigurationKindKey,
    id: string,
    version: number,
    deleted: boolean,
  ): Promise<void> {
    const tx = requireTransaction();
    const where = { id, tenantId: this.tenantId(), version };
    const data = {
      ...(deleted ? this.stamps.deletion() : this.stamps.restoration()),
      version: { increment: 1 },
    };

    const { count } = await this.claimingUnique(kind, () =>
      (() => {
        switch (kind) {
          case ConfigurationKind.CONFIDENTIALITY:
            return tx.confidentialityLevel.updateMany({ where, data });
          case ConfigurationKind.RETENTION:
            return tx.retentionPolicy.updateMany({ where, data });
          case ConfigurationKind.CATEGORY:
            return tx.category.updateMany({ where, data });
          case ConfigurationKind.METADATA_FIELD:
            return tx.metadataField.updateMany({ where, data });
          case ConfigurationKind.DOCUMENT_TYPE:
            return tx.documentType.updateMany({ where, data });
          case ConfigurationKind.NUMBERING_RULE:
            return tx.numberingRule.updateMany({ where, data });
          default:
            return Promise.resolve({ count: 0 });
        }
      })(),
    );
    this.requireOneRow(count, version);
  }

  async dependentsOf(
    kind: ConfigurationKindKey,
    id: string,
  ): Promise<Readonly<Record<string, number>>> {
    const tx = requireTransaction();
    const tenantId = this.tenantId();
    const live = { tenantId, deletedAt: null };

    switch (kind) {
      case ConfigurationKind.CONFIDENTIALITY:
        return {
          documentTypes: await tx.documentType.count({
            where: { ...live, defaultConfidentialityId: id },
          }),
        };

      case ConfigurationKind.RETENTION:
        return {
          documentTypes: await tx.documentType.count({ where: { ...live, retentionPolicyId: id } }),
        };

      case ConfigurationKind.CATEGORY:
        return { subCategories: await tx.category.count({ where: { ...live, parentId: id } }) };

      case ConfigurationKind.METADATA_FIELD:
        // The join carries no soft delete, so a field attached to a live type is what blocks it.
        return {
          documentTypes: await tx.typeMetadataField.count({
            where: { tenantId, metadataFieldId: id, documentType: { deletedAt: null } },
          }),
        };

      case ConfigurationKind.NUMBERING_RULE:
        return {
          documentTypes: await tx.documentType.count({ where: { ...live, numberingRuleId: id } }),
        };

      case ConfigurationKind.DOCUMENT_TYPE:
        // Nothing configuration-side points at a type. Documents will, and Phase 3 adds that count
        // here rather than anywhere else.
        return {};

      default:
        return {};
    }
  }

  /**
   * The table a kind lives in, for the two statements that must name it in SQL — Slice 110.
   *
   * A map rather than a second `switch`, because the pair below has to agree: a kind whose
   * reference is resolved under a lock and whose deletion takes a different lock would be a kind
   * the two halves never meet on, which is the whole of the defect this closes.
   */
  private static readonly TABLES: Readonly<Record<ConfigurationKindKey, string>> = {
    [ConfigurationKind.CONFIDENTIALITY]: 'confidentiality_level',
    [ConfigurationKind.RETENTION]: 'retention_policy',
    [ConfigurationKind.CATEGORY]: 'category',
    [ConfigurationKind.METADATA_FIELD]: 'metadata_field',
    [ConfigurationKind.DOCUMENT_TYPE]: 'document_type',
    [ConfigurationKind.NUMBERING_RULE]: 'numbering_rule',
    // Workflow's table. `liveIds` already reads it to answer "does this reference resolve"; holding
    // the row it read is the same question asked so the answer survives the transaction.
    [ConfigurationKind.WORKFLOW_DEFINITION]: 'workflow_definition',
  };

  /**
   * Holds a configuration row for the rest of the transaction, exclusively — Slice 110.
   *
   * Taken by a delete before it counts what points at it. "Nothing live still points at this" is a
   * decision about *other* tables, so no predicate on this row can carry it and no lock on those
   * rows can either: the dependency is created by an `UPDATE` of a row that already exists, and a
   * count cannot hold a row that is not there yet. What the two sides *can* meet on is the row
   * being deleted, which is the one row both of them name — the delete exclusively here, and the
   * reference resolution shared in `liveIds`.
   */
  async lockForDelete(kind: ConfigurationKindKey, id: string): Promise<void> {
    const table = PrismaConfigurationRepository.TABLES[kind];
    await requireTransaction().$queryRawUnsafe(
      `SELECT id FROM ${table} WHERE id = $1::uuid AND tenant_id = $2::uuid FOR UPDATE`,
      id,
      this.tenantId(),
    );
  }

  /**
   * Resolves references, holding what it resolved — Slice 110.
   *
   * `FOR SHARE` rather than `FOR UPDATE`: two document types naming one confidentiality level are
   * not in conflict with each other and must not queue, but either of them is in conflict with the
   * deletion of that level. `FOR SHARE` conflicts with the plain `UPDATE` `setDeleted` issues, so
   * the two orders both come out right — the delete waits and then sees the new dependant, or it
   * goes first and this read comes back without the row, which is the refusal a caller naming a
   * deleted reference already gets.
   */
  async liveIds(kind: ConfigurationKindKey, ids: readonly string[]): Promise<readonly string[]> {
    if (ids.length === 0) {
      return [];
    }
    const tx = requireTransaction();
    await tx.$queryRawUnsafe(
      `SELECT id FROM ${PrismaConfigurationRepository.TABLES[kind]}
       WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid AND deleted_at IS NULL
       ORDER BY id
       FOR SHARE`,
      [...ids],
      this.tenantId(),
    );
    const where = { tenantId: this.tenantId(), id: { in: [...ids] }, deletedAt: null };
    const select = { id: true } as const;

    const rows = await (() => {
      switch (kind) {
        case ConfigurationKind.CONFIDENTIALITY:
          return tx.confidentialityLevel.findMany({ where, select });
        case ConfigurationKind.RETENTION:
          return tx.retentionPolicy.findMany({ where, select });
        case ConfigurationKind.CATEGORY:
          return tx.category.findMany({ where, select });
        case ConfigurationKind.METADATA_FIELD:
          return tx.metadataField.findMany({ where, select });
        case ConfigurationKind.DOCUMENT_TYPE:
          return tx.documentType.findMany({ where, select });
        case ConfigurationKind.NUMBERING_RULE:
          return tx.numberingRule.findMany({ where, select });
        case ConfigurationKind.WORKFLOW_DEFINITION:
          // Owned by the Workflow module. Read here only to answer "does this reference resolve",
          // which is a question about existence rather than about workflow behaviour — the boundary
          // rule forbids reaching into another module's *code*, not counting a row a foreign key
          // already points at.
          return tx.workflowDefinition.findMany({ where, select });
        default:
          return Promise.resolve([]);
      }
    })();

    return rows.map((row) => row.id);
  }

  // --- Internals -------------------------------------------------------------------------

  /**
   * Everything at or below a category, resolved to a path prefix here.
   *
   * Never accepted as a prefix from the caller: a client that could send one could send `''` and read
   * the whole tenant's tree in a single page.
   */
  private async categoryUnder(
    underId: string | undefined,
  ): Promise<{ OR?: Prisma.CategoryWhereInput[] } | Record<never, never>> {
    if (underId === undefined) {
      return {};
    }
    const root = await requireTransaction().category.findFirst({
      where: { id: underId, tenantId: this.tenantId(), deletedAt: null },
      select: { path: true },
    });
    if (!root) {
      // An unknown node reaches nothing, rather than everything — which is what an empty prefix
      // would do.
      return { OR: [{ id: '00000000-0000-0000-0000-000000000000' }] };
    }
    return { OR: [{ id: underId }, { path: { startsWith: subtreePrefix(root.path) } }] };
  }

  /**
   * Whether a code or key is already used by a live row of one table.
   *
   * One method for six tables, keyed on the delegate name, because the query is identical and the
   * comparison — case-insensitive, live rows only — is the part that must not vary between them.
   */
  private async codeTaken(
    table:
      | 'confidentialityLevel'
      | 'retentionPolicy'
      | 'category'
      | 'metadataField'
      | 'documentType'
      | 'numberingRule',
    column: 'code' | 'key',
    value: string,
    exceptId: string | null,
  ): Promise<boolean> {
    const tx = requireTransaction();
    const where = {
      tenantId: this.tenantId(),
      deletedAt: null,
      [column]: { equals: value, mode: 'insensitive' as const },
      ...(exceptId !== null && { id: { not: exceptId } }),
    };
    const select = { id: true } as const;

    const found = await (() => {
      switch (table) {
        case 'confidentialityLevel':
          return tx.confidentialityLevel.findFirst({ where, select });
        case 'retentionPolicy':
          return tx.retentionPolicy.findFirst({ where, select });
        case 'category':
          return tx.category.findFirst({ where, select });
        case 'metadataField':
          return tx.metadataField.findFirst({ where, select });
        case 'documentType':
          return tx.documentType.findFirst({ where, select });
        case 'numberingRule':
          return tx.numberingRule.findFirst({ where, select });
      }
    })();
    return found !== null;
  }

  private identity(
    id: string,
    includeDeleted: boolean,
  ): { id: string; tenantId: string; deletedAt?: null } {
    return { id, tenantId: this.tenantId(), ...(includeDeleted ? {} : { deletedAt: null }) };
  }

  /**
   * Runs a write that can reach a unique index, and answers the way the second-comer is answered.
   *
   * Translating rather than tolerating, Slice 63's rule: the violation has already aborted the
   * transaction, so there is nothing left to read and nothing to recover — only the exception the
   * caller meets, which must be the refusal rather than a `PrismaClientKnownRequestError` that
   * `AllExceptionsFilter` can only render as a `500`.
   *
   * A kind with no entry in `CLAIMS` is left exactly as it was: its index is not determined by the
   * error, and a refusal naming the wrong field would be worse than the one it replaced.
   */
  private async claimingUnique<TResult>(
    kind: ConfigurationKindKey,
    write: () => Promise<TResult>,
  ): Promise<TResult> {
    const claim = CLAIMS[kind];
    if (claim === undefined) {
      return write();
    }
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolationOn(error, claim.model)) {
        throw new DuplicateError(claim.resource, claim.field);
      }
      throw error;
    }
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }

  private requireOneRow(count: number, expectedVersion: number): void {
    if (count === 0) {
      throw new VersionConflictError(expectedVersion, -1);
    }
  }
}

const DOCUMENT_TYPE_RELATIONS = {
  numberingRule: { select: { name: true } },
  workflowDefinition: { select: { name: true } },
  retentionPolicy: { select: { name: true } },
  confidentiality: { select: { name: true } },
  fields: {
    orderBy: { sortOrder: 'asc' },
    select: {
      metadataFieldId: true,
      isRequired: true,
      sortOrder: true,
      defaultValue: true,
      /*
       * `options` and `description` join the three that were already here, and the reason is a
       * dependency they delete rather than anything this screen renders. A form filling in a
       * type's fields needs a `SELECT` field's choices and its hint; without them here, every
       * consumer had to fetch the *whole* metadata field catalogue — `/admin/fields`, behind
       * `settings:manage`, including fields attached to no type and the tenant-authored
       * validation regexes — purely to join two columns back onto rows it already had.
       */
      field: {
        select: { key: true, name: true, dataType: true, options: true, description: true },
      },
    },
  },
} as const;

// --- Mappers ------------------------------------------------------------------------------

interface Stamps {
  id: string;
  createdAt: Date;
  createdBy: string | null;
  updatedAt: Date;
  updatedBy: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  version: number;
}

function stampsOf(row: Stamps): Stamps {
  return {
    id: row.id,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    deletedAt: row.deletedAt,
    deletedBy: row.deletedBy,
    version: row.version,
  };
}

function toConfidentiality(
  row: Stamps & {
    code: string;
    name: string;
    description: string | null;
    rank: number;
    allowDownload: boolean;
    allowPrint: boolean;
    watermark: boolean;
    requireReason: boolean;
    _count: { documentTypes: number };
  },
): ConfidentialityLevelRow {
  return {
    ...stampsOf(row),
    code: row.code,
    name: row.name,
    description: row.description,
    rank: row.rank,
    allowDownload: row.allowDownload,
    allowPrint: row.allowPrint,
    watermark: row.watermark,
    requireReason: row.requireReason,
    documentTypeCount: row._count.documentTypes,
  };
}

function toRetention(
  row: Stamps & {
    code: string;
    name: string;
    description: string | null;
    trigger: RetentionPolicyRow['trigger'];
    periodMonths: number;
    disposition: RetentionPolicyRow['disposition'];
    reviewRequired: boolean;
    _count: { documentTypes: number };
  },
): RetentionPolicyRow {
  return {
    ...stampsOf(row),
    code: row.code,
    name: row.name,
    description: row.description,
    trigger: row.trigger,
    periodMonths: row.periodMonths,
    disposition: row.disposition,
    reviewRequired: row.reviewRequired,
    documentTypeCount: row._count.documentTypes,
  };
}

function toCategory(
  row: Stamps & {
    parentId: string | null;
    code: string;
    name: string;
    description: string | null;
    path: string;
    _count: { children: number };
  },
): CategoryRow {
  return {
    ...stampsOf(row),
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    description: row.description,
    path: row.path,
    childCount: row._count.children,
  };
}

/**
 * The parent a rewritten path puts a category under.
 *
 * A move swaps a prefix, so the identifiers below the moved node are the ones the subtree already
 * had: the second-to-last segment of a descendant's *new* path names the same parent its old one
 * did. Derived from the path being written rather than carried alongside it, so the guard cannot
 * come to disagree with what it guards.
 */
function parentIdIn(path: string): string | null {
  return ancestorIdsOf(path).at(-1) ?? null;
}

function toMetadataField(
  row: Stamps & {
    key: string;
    name: string;
    description: string | null;
    dataType: MetadataFieldRow['dataType'];
    options: unknown;
    validation: unknown;
    isSearchable: boolean;
    _count: { documentTypes: number };
  },
): MetadataFieldRow {
  return {
    ...stampsOf(row),
    key: row.key,
    name: row.name,
    description: row.description,
    dataType: row.dataType,
    options: narrowOptions(row.options),
    validation: narrowValidation(row.validation),
    isSearchable: row.isSearchable,
    documentTypeCount: row._count.documentTypes,
  };
}

function toDocumentType(
  row: Stamps & {
    code: string;
    name: string;
    description: string | null;
    numberingRuleId: string;
    workflowDefinitionId: string | null;
    retentionPolicyId: string | null;
    defaultConfidentialityId: string;
    revisionLabelStyle: DocumentTypeRow['revisionLabelStyle'];
    isActive: boolean;
    numberingRule: { name: string };
    workflowDefinition: { name: string } | null;
    retentionPolicy: { name: string } | null;
    confidentiality: { name: string };
    fields: {
      metadataFieldId: string;
      isRequired: boolean;
      sortOrder: number;
      defaultValue: string | null;
      field: {
        key: string;
        name: string;
        dataType: MetadataFieldRow['dataType'];
        options: unknown;
        description: string | null;
      };
    }[];
  },
): DocumentTypeRow {
  return {
    ...stampsOf(row),
    code: row.code,
    name: row.name,
    description: row.description,
    numberingRuleId: row.numberingRuleId,
    numberingRuleName: row.numberingRule.name,
    workflowDefinitionId: row.workflowDefinitionId,
    workflowDefinitionName: row.workflowDefinition?.name ?? null,
    retentionPolicyId: row.retentionPolicyId,
    retentionPolicyName: row.retentionPolicy?.name ?? null,
    defaultConfidentialityId: row.defaultConfidentialityId,
    defaultConfidentialityName: row.confidentiality.name,
    revisionLabelStyle: row.revisionLabelStyle,
    isActive: row.isActive,
    fields: row.fields.map((attached) => ({
      metadataFieldId: attached.metadataFieldId,
      isRequired: attached.isRequired,
      sortOrder: attached.sortOrder,
      defaultValue: attached.defaultValue,
      key: attached.field.key,
      name: attached.field.name,
      dataType: attached.field.dataType,
      options: narrowOptions(attached.field.options),
      description: attached.field.description,
    })),
  };
}

function toNumberingRule(
  row: Stamps & {
    key: string;
    name: string;
    description: string | null;
    separator: string;
    segments: unknown;
    resetScope: SequenceResetScopeKey[];
    reserveOnSubmit: boolean;
    strictGapless: boolean;
    _count: { sequences: number; documentTypes: number };
  },
): NumberingRuleRow {
  return {
    ...stampsOf(row),
    key: row.key,
    name: row.name,
    description: row.description,
    separator: row.separator,
    segments: narrowSegments(row.segments),
    resetScope: row.resetScope,
    reserveOnSubmit: row.reserveOnSubmit,
    strictGapless: row.strictGapless,
    sequenceCount: row._count.sequences,
    documentTypeCount: row._count.documentTypes,
  };
}

/**
 * Narrows a `jsonb` column read back as `unknown`.
 *
 * Not a cast. These columns are written through a validated contract, but a row from an older release
 * or a hand-edited `jsonb` can hold a shape the formatter cannot render — and a formatter that threw
 * on it would take down the endpoint that lists the rules rather than the one that saved the bad row.
 * Anything unrecognised is dropped, which degrades a rule's preview instead of the screen.
 */
function narrowSegments(raw: unknown): readonly NumberSegment[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is NumberSegment =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { kind?: unknown }).kind === 'string',
  );
}

function narrowOptions(raw: unknown): readonly MetadataOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is MetadataOption => {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const candidate = entry as { value?: unknown; label?: unknown };
    return typeof candidate.value === 'string' && typeof candidate.label === 'string';
  });
}

function narrowValidation(raw: unknown): MetadataValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  const candidate = raw as Record<string, unknown>;
  const numeric = (key: string): number | undefined => {
    const value = candidate[key];
    return typeof value === 'number' ? value : undefined;
  };

  return {
    ...(numeric('minLength') !== undefined && { minLength: numeric('minLength') }),
    ...(numeric('maxLength') !== undefined && { maxLength: numeric('maxLength') }),
    ...(numeric('minimum') !== undefined && { minimum: numeric('minimum') }),
    ...(numeric('maximum') !== undefined && { maximum: numeric('maximum') }),
    ...(typeof candidate['pattern'] === 'string' && { pattern: candidate['pattern'] }),
  };
}
