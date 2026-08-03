import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  type DispositionKey,
  type MetadataDataTypeKey,
  type RetentionTriggerKey,
  type RevisionLabelStyleKey,
  asId,
  isUsableCode,
  pathFor,
  relativeDepthOf,
  rewriteSubtree,
  requiresOptions,
} from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  AdministeredWriter,
  AdministrativeOperation,
  type AdministrativeOperationKey,
  checkVersion,
  requireVersion,
} from '../../../core/persistence';
import {
  DuplicateError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { AdministrationAudit } from '../domain/audit-actions';
import { documentTypeChangedEvent } from '../domain/events';
import { MAXIMUM_CATEGORY_DEPTH, checkCategoryPlacement } from '../domain/category-tree';
import {
  type CategoryListRequest,
  type CategoryRow,
  CONFIGURATION_REPOSITORY,
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
  type RetentionListRequest,
  type RetentionPolicyRow,
  type TypeField,
} from './administration.ports';

/** The longest a tenant-authored regular expression may be. Compiled once, at save time. */
const MAXIMUM_PATTERN_LENGTH = 200;

/**
 * The configuration a tenant edits instead of waiting for a release.
 *
 * Five aggregates here and numbering next door, and what makes them more than five sets of CRUD is
 * that documents will *freeze* what they need from them. So the rules that matter are the ones about
 * change over time:
 *
 * **A document type's edits apply to documents created afterwards.** Nothing is recomputed. That is
 * why every reference is to a configuration row rather than a copy of it, and why
 * `administration.document-type-changed` is published — a consumer that cached a type's policy needs
 * to know, and a document that already exists does not.
 *
 * **A field's data type is immutable.** The value columns a document stores are typed, so a `TEXT`
 * value has nowhere to go in a `NUMBER` field. A field of the wrong type is deleted and replaced
 * while it is unused, which is why the delete refuses when a type still requires it.
 *
 * **A confidentiality rank is unique.** Workflow conditions compare it and audit-on-read is triggered
 * by it, so "more sensitive than" has to be a total order or those questions have no answer.
 *
 * **A tenant-authored pattern is compiled at save time.** An invalid regular expression stored on a
 * field would throw on every document that used it, at validation time, in front of an author who
 * cannot fix it.
 */
@Injectable()
export class ConfigurationService {
  constructor(
    @Inject(CONFIGURATION_REPOSITORY) private readonly config: ConfigurationRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  // --- Confidentiality levels ------------------------------------------------------------

  listConfidentiality(request: ConfigListRequest): Promise<Page<ConfidentialityLevelRow>> {
    return this.writer.read(() => this.config.listConfidentiality(request));
  }

  getConfidentiality(id: string): Promise<ConfidentialityLevelRow> {
    return this.writer.read(() => this.requireConfidentiality(id, true));
  }

  async createConfidentiality(input: {
    code: string;
    name: string;
    description?: string | undefined;
    rank: number;
    allowDownload: boolean;
    allowPrint: boolean;
    watermark: boolean;
    requireReason: boolean;
  }): Promise<ConfidentialityLevelRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);

    return this.writer.write(async () => {
      if (await this.config.confidentialityCodeTaken(code, null)) {
        throw new DuplicateError('confidentiality level', 'code');
      }
      if (await this.config.confidentialityRankTaken(input.rank, null)) {
        throw new DuplicateError('confidentiality level', 'rank');
      }

      const id = this.writer.clock.nextId();
      await this.config.insertConfidentiality({
        id,
        code,
        name,
        description: this.optionalText(input.description),
        rank: input.rank,
        allowDownload: input.allowDownload,
        allowPrint: input.allowPrint,
        watermark: input.watermark,
        requireReason: input.requireReason,
      });

      return {
        result: await this.requireConfidentiality(id, false),
        change: this.policyChanged(id, AdministrativeOperation.CREATED, undefined, {
          code,
          name,
          rank: input.rank,
        }),
      };
    });
  }

  async updateConfidentiality(
    id: string,
    patch: Partial<{
      code: string;
      name: string;
      description: string | null;
      rank: number;
      allowDownload: boolean;
      allowPrint: boolean;
      watermark: boolean;
      requireReason: boolean;
    }>,
    expectedVersion: number | undefined,
  ): Promise<ConfidentialityLevelRow> {
    return this.writer.write(async () => {
      const current = await this.requireConfidentiality(id, false);
      checkVersion(expectedVersion, current.version);

      const code = patch.code === undefined ? undefined : this.requireCode(patch.code);
      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      if (code !== undefined && !sameCode(code, current.code)) {
        if (await this.config.confidentialityCodeTaken(code, id)) {
          throw new DuplicateError('confidentiality level', 'code');
        }
      }
      if (patch.rank !== undefined && patch.rank !== current.rank) {
        if (await this.config.confidentialityRankTaken(patch.rank, id)) {
          throw new DuplicateError('confidentiality level', 'rank');
        }
      }

      await this.config.updateConfidentiality(id, current.version, {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && {
          description: this.nullableText(patch.description),
        }),
        ...(patch.rank !== undefined && { rank: patch.rank }),
        ...(patch.allowDownload !== undefined && { allowDownload: patch.allowDownload }),
        ...(patch.allowPrint !== undefined && { allowPrint: patch.allowPrint }),
        ...(patch.watermark !== undefined && { watermark: patch.watermark }),
        ...(patch.requireReason !== undefined && { requireReason: patch.requireReason }),
      });

      return {
        result: await this.requireConfidentiality(id, false),
        change: this.policyChanged(
          id,
          AdministrativeOperation.UPDATED,
          previousOf(current, patch),
          definedOnly(patch),
        ),
      };
    });
  }

  // --- Retention policies ----------------------------------------------------------------

  listRetention(request: RetentionListRequest): Promise<Page<RetentionPolicyRow>> {
    return this.writer.read(() => this.config.listRetention(request));
  }

  getRetention(id: string): Promise<RetentionPolicyRow> {
    return this.writer.read(() => this.requireRetention(id, true));
  }

  async createRetention(input: {
    code: string;
    name: string;
    description?: string | undefined;
    trigger: RetentionTriggerKey;
    periodMonths: number;
    disposition: DispositionKey;
    reviewRequired: boolean;
  }): Promise<RetentionPolicyRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);

    return this.writer.write(async () => {
      if (await this.config.retentionCodeTaken(code, null)) {
        throw new DuplicateError('retention policy', 'code');
      }

      const id = this.writer.clock.nextId();
      await this.config.insertRetention({
        id,
        code,
        name,
        description: this.optionalText(input.description),
        trigger: input.trigger,
        periodMonths: input.periodMonths,
        disposition: input.disposition,
        reviewRequired: input.reviewRequired,
      });

      return {
        result: await this.requireRetention(id, false),
        change: this.policyChanged(id, AdministrativeOperation.CREATED, undefined, {
          code,
          trigger: input.trigger,
          periodMonths: input.periodMonths,
          disposition: input.disposition,
        }),
      };
    });
  }

  async updateRetention(
    id: string,
    patch: Partial<{
      code: string;
      name: string;
      description: string | null;
      trigger: RetentionTriggerKey;
      periodMonths: number;
      disposition: DispositionKey;
      reviewRequired: boolean;
    }>,
    expectedVersion: number | undefined,
  ): Promise<RetentionPolicyRow> {
    return this.writer.write(async () => {
      const current = await this.requireRetention(id, false);
      checkVersion(expectedVersion, current.version);

      const code = patch.code === undefined ? undefined : this.requireCode(patch.code);
      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      if (code !== undefined && !sameCode(code, current.code)) {
        if (await this.config.retentionCodeTaken(code, id)) {
          throw new DuplicateError('retention policy', 'code');
        }
      }

      // The database holds this too, as a check constraint. Checking here is what makes the message
      // say which field is wrong rather than naming a constraint.
      const disposition = patch.disposition ?? current.disposition;
      const period = patch.periodMonths ?? current.periodMonths;
      if (disposition === 'RETAIN_FOREVER' && period !== 0) {
        throw new ValidationError('A policy that retains forever has no period.', [
          { field: 'periodMonths', message: 'must be zero' },
        ]);
      }
      if (disposition !== 'RETAIN_FOREVER' && period === 0) {
        throw new ValidationError('State how long the record is kept before this runs.', [
          { field: 'periodMonths', message: 'required' },
        ]);
      }

      await this.config.updateRetention(id, current.version, {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && {
          description: this.nullableText(patch.description),
        }),
        ...(patch.trigger !== undefined && { trigger: patch.trigger }),
        ...(patch.periodMonths !== undefined && { periodMonths: patch.periodMonths }),
        ...(patch.disposition !== undefined && { disposition: patch.disposition }),
        ...(patch.reviewRequired !== undefined && { reviewRequired: patch.reviewRequired }),
      });

      return {
        result: await this.requireRetention(id, false),
        change: this.policyChanged(
          id,
          AdministrativeOperation.UPDATED,
          previousOf(current, patch),
          definedOnly(patch),
        ),
      };
    });
  }

  // --- Categories ------------------------------------------------------------------------

  listCategories(request: CategoryListRequest): Promise<Page<CategoryRow>> {
    return this.writer.read(() => this.config.listCategories(request));
  }

  getCategory(id: string): Promise<CategoryRow> {
    return this.writer.read(() => this.requireCategory(id, true));
  }

  async createCategory(input: {
    parentId?: string | null | undefined;
    code: string;
    name: string;
    description?: string | undefined;
  }): Promise<CategoryRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);
    const parentId = input.parentId ?? null;

    return this.writer.write(async () => {
      const parent = parentId === null ? null : await this.requireCategory(parentId, false);

      this.refusePlacement(
        checkCategoryPlacement({
          nodeId: null,
          nodePath: null,
          parentId,
          parentPath: parent?.path ?? null,
        }),
      );
      if (await this.config.categoryCodeTaken(code, null)) {
        throw new DuplicateError('category', 'code');
      }
      if (await this.config.categorySiblingNameTaken(parentId, name, null)) {
        throw new DuplicateError('category', 'name');
      }

      const id = this.writer.clock.nextId();
      await this.config.insertCategory({
        id,
        parentId,
        code,
        name,
        description: this.optionalText(input.description),
        path: pathFor(parent?.path ?? null, id),
      });

      return {
        result: await this.requireCategory(id, false),
        change: this.fieldChanged(id, AdministrativeOperation.CREATED, undefined, {
          code,
          name,
          parentId,
        }),
      };
    });
  }

  async updateCategory(
    id: string,
    patch: Partial<{
      code: string;
      name: string;
      description: string | null;
      parentId: string | null;
    }>,
    expectedVersion: number | undefined,
  ): Promise<CategoryRow> {
    // A changed parent is a move, whichever endpoint it arrived on — the same reasoning as a
    // department: it rewrites a subtree of paths, so it must not be an ordinary field write.
    if (patch.parentId !== undefined) {
      await this.moveCategory(id, patch.parentId, expectedVersion);
    }
    const rest = { ...patch };
    delete rest.parentId;
    if (Object.keys(rest).length === 0) {
      return this.getCategory(id);
    }

    return this.writer.write(async () => {
      const current = await this.requireCategory(id, false);
      checkVersion(
        patch.parentId === undefined ? expectedVersion : current.version,
        current.version,
      );

      const code = rest.code === undefined ? undefined : this.requireCode(rest.code);
      const name = rest.name === undefined ? undefined : this.requireName(rest.name);
      if (code !== undefined && !sameCode(code, current.code)) {
        if (await this.config.categoryCodeTaken(code, id)) {
          throw new DuplicateError('category', 'code');
        }
      }
      if (name !== undefined && name.toLowerCase() !== current.name.toLowerCase()) {
        if (await this.config.categorySiblingNameTaken(current.parentId, name, id)) {
          throw new DuplicateError('category', 'name');
        }
      }

      await this.config.updateCategory(id, current.version, {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(rest.description !== undefined && { description: this.nullableText(rest.description) }),
      });

      return {
        result: await this.requireCategory(id, false),
        change: this.fieldChanged(
          id,
          AdministrativeOperation.UPDATED,
          previousOf(current, rest),
          definedOnly(rest),
        ),
      };
    });
  }

  async moveCategory(
    id: string,
    parentId: string | null,
    expectedVersion: number | undefined,
  ): Promise<CategoryRow> {
    return this.writer.write(async () => {
      const current = await this.requireCategory(id, false);
      requireVersion(expectedVersion, current.version);
      const parent = parentId === null ? null : await this.requireCategory(parentId, false);

      this.refusePlacement(
        checkCategoryPlacement({
          nodeId: id,
          nodePath: current.path,
          parentId,
          parentPath: parent?.path ?? null,
        }),
      );

      const subtree = await this.config.categorySubtree(current.path);
      const height = relativeDepthOf(subtree, current.path);
      const parentDepth = parent === null ? 0 : parent.path.split('.').length;
      if (parentDepth + height > MAXIMUM_CATEGORY_DEPTH) {
        throw new ValidationError(
          `Categories may not nest more than ${String(MAXIMUM_CATEGORY_DEPTH)} levels deep.`,
          [{ field: 'parentId', message: 'TOO_DEEP' }],
        );
      }
      // The name has to be free among its *new* siblings, not its old ones.
      if (await this.config.categorySiblingNameTaken(parentId, current.name, id)) {
        throw new DuplicateError('category', 'name');
      }

      const toPath = pathFor(parent?.path ?? null, id);
      await this.config.moveCategory({
        id,
        version: current.version,
        parentId,
        paths: [...rewriteSubtree(subtree, current.path, toPath)],
      });

      return {
        result: await this.requireCategory(id, false),
        change: this.fieldChanged(
          id,
          AdministrativeOperation.MOVED,
          { parentId: current.parentId, path: current.path },
          { parentId, path: toPath, subtreeSize: subtree.length },
        ),
      };
    });
  }

  // --- Metadata fields -------------------------------------------------------------------

  listMetadataFields(request: MetadataFieldListRequest): Promise<Page<MetadataFieldRow>> {
    return this.writer.read(() => this.config.listMetadataFields(request));
  }

  getMetadataField(id: string): Promise<MetadataFieldRow> {
    return this.writer.read(() => this.requireMetadataField(id, true));
  }

  async createMetadataField(input: {
    key: string;
    name: string;
    description?: string | undefined;
    dataType: MetadataDataTypeKey;
    options: readonly MetadataOption[];
    validation: MetadataValidation;
    isSearchable: boolean;
  }): Promise<MetadataFieldRow> {
    const key = input.key.trim().toLowerCase();
    const name = this.requireName(input.name);
    this.checkFieldShape(input.dataType, input.options, input.validation);

    return this.writer.write(async () => {
      if (await this.config.metadataFieldKeyTaken(key, null)) {
        throw new DuplicateError('field', 'key');
      }

      const id = this.writer.clock.nextId();
      await this.config.insertMetadataField({
        id,
        key,
        name,
        description: this.optionalText(input.description),
        dataType: input.dataType,
        options: input.options,
        validation: input.validation,
        isSearchable: input.isSearchable,
      });

      return {
        result: await this.requireMetadataField(id, false),
        change: this.fieldChanged(id, AdministrativeOperation.CREATED, undefined, {
          key,
          name,
          dataType: input.dataType,
        }),
      };
    });
  }

  async updateMetadataField(
    id: string,
    patch: Partial<{
      name: string;
      description: string | null;
      options: readonly MetadataOption[];
      validation: MetadataValidation;
      isSearchable: boolean;
    }>,
    expectedVersion: number | undefined,
  ): Promise<MetadataFieldRow> {
    return this.writer.write(async () => {
      const current = await this.requireMetadataField(id, false);
      checkVersion(expectedVersion, current.version);

      // The data type cannot change, so the shape is re-checked against the *stored* type.
      this.checkFieldShape(
        current.dataType,
        patch.options ?? current.options,
        patch.validation ?? current.validation,
      );

      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      await this.config.updateMetadataField(id, current.version, {
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && {
          description: this.nullableText(patch.description),
        }),
        ...(patch.options !== undefined && { options: patch.options }),
        ...(patch.validation !== undefined && { validation: patch.validation }),
        ...(patch.isSearchable !== undefined && { isSearchable: patch.isSearchable }),
      });

      return {
        result: await this.requireMetadataField(id, false),
        change: this.fieldChanged(
          id,
          AdministrativeOperation.UPDATED,
          previousOf(current, patch),
          definedOnly(patch),
        ),
      };
    });
  }

  // --- Document types --------------------------------------------------------------------

  listDocumentTypes(request: DocumentTypeListRequest): Promise<Page<DocumentTypeRow>> {
    return this.writer.read(() => this.config.listDocumentTypes(request));
  }

  getDocumentType(id: string): Promise<DocumentTypeRow> {
    return this.writer.read(() => this.requireDocumentType(id, true));
  }

  async createDocumentType(input: {
    code: string;
    name: string;
    description?: string | undefined;
    numberingRuleId: string;
    workflowDefinitionId?: string | null | undefined;
    retentionPolicyId?: string | null | undefined;
    defaultConfidentialityId: string;
    revisionLabelStyle: RevisionLabelStyleKey;
    isActive: boolean;
    fields: readonly TypeField[];
  }): Promise<DocumentTypeRow> {
    const code = this.requireCode(input.code);
    const name = this.requireName(input.name);
    this.checkFieldList(input.fields);

    return this.writer.write(async () => {
      if (await this.config.documentTypeCodeTaken(code, null)) {
        throw new DuplicateError('document type', 'code');
      }
      await this.requireReferences({
        numberingRuleId: input.numberingRuleId,
        defaultConfidentialityId: input.defaultConfidentialityId,
        workflowDefinitionId: input.workflowDefinitionId ?? null,
        retentionPolicyId: input.retentionPolicyId ?? null,
        fieldIds: input.fields.map((field) => field.metadataFieldId),
      });

      const id = this.writer.clock.nextId();
      await this.config.insertDocumentType({
        id,
        code,
        name,
        description: this.optionalText(input.description),
        numberingRuleId: input.numberingRuleId,
        workflowDefinitionId: input.workflowDefinitionId ?? null,
        retentionPolicyId: input.retentionPolicyId ?? null,
        defaultConfidentialityId: input.defaultConfidentialityId,
        revisionLabelStyle: input.revisionLabelStyle,
        isActive: input.isActive,
      });
      await this.config.replaceTypeFields(id, input.fields);

      return {
        result: await this.requireDocumentType(id, false),
        change: this.typeChanged(id, AdministrativeOperation.CREATED, undefined, { code, name }),
      };
    });
  }

  async updateDocumentType(
    id: string,
    patch: Partial<{
      code: string;
      name: string;
      description: string | null;
      numberingRuleId: string;
      workflowDefinitionId: string | null;
      retentionPolicyId: string | null;
      defaultConfidentialityId: string;
      revisionLabelStyle: RevisionLabelStyleKey;
      isActive: boolean;
      fields: readonly TypeField[];
    }>,
    expectedVersion: number | undefined,
  ): Promise<DocumentTypeRow> {
    if (patch.fields !== undefined) {
      this.checkFieldList(patch.fields);
    }

    return this.writer.write(async () => {
      const current = await this.requireDocumentType(id, false);
      checkVersion(expectedVersion, current.version);

      const code = patch.code === undefined ? undefined : this.requireCode(patch.code);
      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      if (code !== undefined && !sameCode(code, current.code)) {
        if (await this.config.documentTypeCodeTaken(code, id)) {
          throw new DuplicateError('document type', 'code');
        }
      }
      await this.requireReferences({
        numberingRuleId: patch.numberingRuleId ?? null,
        defaultConfidentialityId: patch.defaultConfidentialityId ?? null,
        workflowDefinitionId: patch.workflowDefinitionId ?? null,
        retentionPolicyId: patch.retentionPolicyId ?? null,
        fieldIds: (patch.fields ?? []).map((field) => field.metadataFieldId),
      });

      await this.config.updateDocumentType(id, current.version, {
        ...(code !== undefined && { code }),
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && {
          description: this.nullableText(patch.description),
        }),
        ...(patch.numberingRuleId !== undefined && { numberingRuleId: patch.numberingRuleId }),
        ...(patch.workflowDefinitionId !== undefined && {
          workflowDefinitionId: patch.workflowDefinitionId,
        }),
        ...(patch.retentionPolicyId !== undefined && {
          retentionPolicyId: patch.retentionPolicyId,
        }),
        ...(patch.defaultConfidentialityId !== undefined && {
          defaultConfidentialityId: patch.defaultConfidentialityId,
        }),
        ...(patch.revisionLabelStyle !== undefined && {
          revisionLabelStyle: patch.revisionLabelStyle,
        }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      });
      if (patch.fields !== undefined) {
        await this.config.replaceTypeFields(id, patch.fields);
      }

      // Affects documents created afterwards only; documents that already exist keep the policy they
      // were created under. Published so anything caching the type's policy reconsiders — and
      // deliberately *not* accompanied by any recomputation.
      const changedFields = Object.keys(definedOnly(patch));
      await this.outbox.publish([
        documentTypeChangedEvent(asId<AnyId>(id), { documentTypeId: id, changedFields }),
      ]);

      return {
        result: await this.requireDocumentType(id, false),
        change: this.typeChanged(
          id,
          AdministrativeOperation.UPDATED,
          previousOf(current, patch),
          definedOnly(patch),
        ),
      };
    });
  }

  // --- Delete and restore ----------------------------------------------------------------

  /**
   * Soft-deletes a configuration row, provided nothing live still points at it.
   *
   * The dependent check is the behaviour worth reading. A confidentiality level a document type
   * defaults to, or a field a type requires, cannot be removed — because a document created afterwards
   * would reference a row that is gone, and the type would be unusable in a way that only shows up
   * when somebody tries to create a document.
   */
  async delete(
    kind: ConfigurationKindKey,
    id: string,
    expectedVersion: number | undefined,
  ): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireAny(kind, id, false);
      requireVersion(expectedVersion, current.version);

      const dependents = await this.config.dependentsOf(kind, id);
      const blocking = Object.entries(dependents).filter(([, count]) => count > 0);
      if (blocking.length > 0) {
        throw new ValidationError(
          'Something still uses this. Change or remove it first.',
          blocking.map(([what, count]) => ({ field: what, message: String(count) })),
        );
      }

      await this.config.setDeleted(kind, id, current.version, true);

      return {
        result: undefined,
        change: this.changedFor(
          kind,
          id,
          AdministrativeOperation.DELETED,
          { deletedAt: null },
          {
            kind,
          },
        ),
      };
    });
  }

  async restore(
    kind: ConfigurationKindKey,
    id: string,
    expectedVersion: number | undefined,
  ): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.requireAny(kind, id, true);
      checkVersion(expectedVersion, current.version);
      if (current.deletedAt === null) {
        return {
          result: undefined,
          change: this.changedFor(kind, id, AdministrativeOperation.RESTORED, undefined, {
            alreadyLive: true,
          }),
        };
      }

      await this.refuseTakenIdentityOnRestore(kind, id);
      await this.config.setDeleted(kind, id, current.version, false);

      return {
        result: undefined,
        change: this.changedFor(
          kind,
          id,
          AdministrativeOperation.RESTORED,
          {
            deletedAt: current.deletedAt,
          },
          { kind },
        ),
      };
    });
  }

  // --- Internals -------------------------------------------------------------------------

  private async requireAny(
    kind: ConfigurationKindKey,
    id: string,
    includeDeleted: boolean,
  ): Promise<{ version: number; deletedAt: Date | null }> {
    switch (kind) {
      case ConfigurationKind.CONFIDENTIALITY:
        return this.requireConfidentiality(id, includeDeleted);
      case ConfigurationKind.RETENTION:
        return this.requireRetention(id, includeDeleted);
      case ConfigurationKind.CATEGORY:
        return this.requireCategory(id, includeDeleted);
      case ConfigurationKind.METADATA_FIELD:
        return this.requireMetadataField(id, includeDeleted);
      case ConfigurationKind.DOCUMENT_TYPE:
        return this.requireDocumentType(id, includeDeleted);
      default:
        // Numbering rules are administered next door and workflow definitions belong to another
        // module; reaching here is a routing mistake rather than a caller's.
        throw new NotFoundError('The requested resource');
    }
  }

  /**
   * Whether the identity a restore would reclaim is free.
   *
   * The code or key was released when the row was deleted and may have been taken since. The partial
   * unique index would refuse the restore anyway; asking first turns a constraint violation into a
   * message naming the collision.
   */
  private async refuseTakenIdentityOnRestore(
    kind: ConfigurationKindKey,
    id: string,
  ): Promise<void> {
    const taken = await (async () => {
      switch (kind) {
        case ConfigurationKind.CONFIDENTIALITY: {
          const row = await this.requireConfidentiality(id, true);
          // Both halves of its identity: a level's rank is as unique as its code.
          return (
            (await this.config.confidentialityCodeTaken(row.code, id)) ||
            (await this.config.confidentialityRankTaken(row.rank, id))
          );
        }
        case ConfigurationKind.RETENTION: {
          const row = await this.requireRetention(id, true);
          return this.config.retentionCodeTaken(row.code, id);
        }
        case ConfigurationKind.CATEGORY: {
          const row = await this.requireCategory(id, true);
          return (
            (await this.config.categoryCodeTaken(row.code, id)) ||
            (await this.config.categorySiblingNameTaken(row.parentId, row.name, id))
          );
        }
        case ConfigurationKind.METADATA_FIELD: {
          const row = await this.requireMetadataField(id, true);
          return this.config.metadataFieldKeyTaken(row.key, id);
        }
        case ConfigurationKind.DOCUMENT_TYPE: {
          const row = await this.requireDocumentType(id, true);
          return this.config.documentTypeCodeTaken(row.code, id);
        }
        default:
          return false;
      }
    })();

    if (taken) {
      throw new DuplicateError('configuration', 'code');
    }
  }

  private async requireConfidentiality(
    id: string,
    includeDeleted: boolean,
  ): Promise<ConfidentialityLevelRow> {
    return found(await this.config.findConfidentiality(id, includeDeleted));
  }

  private async requireRetention(id: string, includeDeleted: boolean): Promise<RetentionPolicyRow> {
    return found(await this.config.findRetention(id, includeDeleted));
  }

  private async requireCategory(id: string, includeDeleted: boolean): Promise<CategoryRow> {
    return found(await this.config.findCategory(id, includeDeleted));
  }

  private async requireMetadataField(
    id: string,
    includeDeleted: boolean,
  ): Promise<MetadataFieldRow> {
    return found(await this.config.findMetadataField(id, includeDeleted));
  }

  private async requireDocumentType(id: string, includeDeleted: boolean): Promise<DocumentTypeRow> {
    return found(await this.config.findDocumentType(id, includeDeleted));
  }

  /**
   * Every reference a document type names, resolved before it is written.
   *
   * A foreign key would refuse a dangling one, but with a message naming a constraint. Resolving them
   * here means the failure says which reference is wrong — and it is also the only place a
   * cross-tenant identifier is caught, because a foreign key does not know about tenants.
   */
  private async requireReferences(refs: {
    numberingRuleId: string | null;
    defaultConfidentialityId: string | null;
    workflowDefinitionId: string | null;
    retentionPolicyId: string | null;
    fieldIds: readonly string[];
  }): Promise<void> {
    const checks: readonly [ConfigurationKindKey, string, readonly string[]][] = [
      [
        ConfigurationKind.NUMBERING_RULE,
        'numberingRuleId',
        refs.numberingRuleId === null ? [] : [refs.numberingRuleId],
      ],
      [
        ConfigurationKind.CONFIDENTIALITY,
        'defaultConfidentialityId',
        refs.defaultConfidentialityId === null ? [] : [refs.defaultConfidentialityId],
      ],
      [
        ConfigurationKind.WORKFLOW_DEFINITION,
        'workflowDefinitionId',
        refs.workflowDefinitionId === null ? [] : [refs.workflowDefinitionId],
      ],
      [
        ConfigurationKind.RETENTION,
        'retentionPolicyId',
        refs.retentionPolicyId === null ? [] : [refs.retentionPolicyId],
      ],
      [ConfigurationKind.METADATA_FIELD, 'fields', refs.fieldIds],
    ];

    for (const [kind, field, ids] of checks) {
      if (ids.length === 0) {
        continue;
      }
      const live = new Set(await this.config.liveIds(kind, ids));
      const missing = ids.filter((id) => !live.has(id));
      if (missing.length > 0) {
        throw new ValidationError('That configuration does not exist.', [
          { field, message: missing.join(', ') },
        ]);
      }
    }
  }

  /** A field's options and validation must agree with its data type. */
  private checkFieldShape(
    dataType: MetadataDataTypeKey,
    options: readonly MetadataOption[],
    validation: MetadataValidation,
  ): void {
    const needsOptions = requiresOptions(dataType);
    if (needsOptions && options.length === 0) {
      throw new ValidationError('A choice field needs at least one option.', [
        { field: 'options', message: 'required' },
      ]);
    }
    if (!needsOptions && options.length > 0) {
      // Silently ignoring them would teach an administrator that they had configured something.
      throw new ValidationError('Only choice fields have options.', [
        { field: 'options', message: 'not applicable' },
      ]);
    }
    const values = options.map((option) => option.value.toLowerCase());
    if (new Set(values).size !== values.length) {
      throw new ValidationError('Two options share the same stored value.', [
        { field: 'options', message: 'duplicate' },
      ]);
    }

    if (validation.pattern !== undefined) {
      if (validation.pattern.length > MAXIMUM_PATTERN_LENGTH) {
        throw new ValidationError('That pattern is too long.', [
          { field: 'validation.pattern', message: 'too long' },
        ]);
      }
      try {
        // Compiled here so an invalid expression is refused at configuration time. Stored, it would
        // throw on every document that used the field, in front of an author who cannot fix it.
        new RegExp(validation.pattern);
      } catch {
        throw new ValidationError('That is not a valid pattern.', [
          { field: 'validation.pattern', message: 'invalid' },
        ]);
      }
    }
    if (
      validation.minLength !== undefined &&
      validation.maxLength !== undefined &&
      validation.minLength > validation.maxLength
    ) {
      throw new ValidationError('The shortest length cannot exceed the longest.', [
        { field: 'validation.minLength', message: 'greater than maximum' },
      ]);
    }
    if (
      validation.minimum !== undefined &&
      validation.maximum !== undefined &&
      validation.minimum > validation.maximum
    ) {
      throw new ValidationError('The smallest value cannot exceed the largest.', [
        { field: 'validation.minimum', message: 'greater than maximum' },
      ]);
    }
  }

  private checkFieldList(fields: readonly TypeField[]): void {
    const ids = fields.map((field) => field.metadataFieldId);
    if (new Set(ids).size !== ids.length) {
      // The join is keyed on `(documentTypeId, metadataFieldId)`, so a repeat would be a constraint
      // violation rather than a no-op.
      throw new ValidationError('A field is attached twice.', [
        { field: 'fields', message: 'duplicate' },
      ]);
    }
  }

  private refusePlacement(rejections: readonly string[]): void {
    if (rejections.length === 0) {
      return;
    }
    throw new ValidationError(
      'That is not a place this category can sit.',
      rejections.map((reason) => ({ field: 'parentId', message: reason })),
    );
  }

  private requireCode(raw: string): string {
    const code = raw.trim();
    if (!isUsableCode(code)) {
      throw new ValidationError(
        'A code is letters, digits and hyphens, not starting with a hyphen, up to 16 characters.',
        [{ field: 'code', message: 'unusable' }],
      );
    }
    return code;
  }

  private requireName(raw: string): string {
    const name = squish(raw);
    if (name.length === 0) {
      throw new ValidationError('A name is required.', [{ field: 'name', message: 'required' }]);
    }
    return name;
  }

  private optionalText(raw: string | undefined): string | null {
    return raw === undefined ? null : squish(raw);
  }

  private nullableText(raw: string | null): string | null {
    return raw === null ? null : squish(raw);
  }

  private policyChanged(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return this.entry(AdministrationAudit.POLICY_CHANGED, id, operation, before, after);
  }

  private fieldChanged(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return this.entry(AdministrationAudit.FIELD_CHANGED, id, operation, before, after);
  }

  private typeChanged(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return this.entry(AdministrationAudit.TYPE_CHANGED, id, operation, before, after);
  }

  private changedFor(
    kind: ConfigurationKindKey,
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    const action =
      kind === ConfigurationKind.DOCUMENT_TYPE
        ? AdministrationAudit.TYPE_CHANGED
        : kind === ConfigurationKind.CATEGORY || kind === ConfigurationKind.METADATA_FIELD
          ? AdministrationAudit.FIELD_CHANGED
          : AdministrationAudit.POLICY_CHANGED;
    return this.entry(action, id, operation, before, after);
  }

  private entry(
    action: string,
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return {
      action,
      subjectType: AuditSubjectType.CONFIGURATION,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before && { before }),
      ...(after && { after }),
    };
  }
}

function found<TRow>(row: TRow | null): TRow {
  if (row === null) {
    // Everything a caller may not see is "not found", including another tenant's row.
    throw new NotFoundError('The requested resource');
  }
  return row;
}

function sameCode(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The keys a patch actually names, so an audit payload never claims `undefined` was written. */
function definedOnly(patch: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

/**
 * The current values of the fields a patch is about to change — and only those.
 *
 * `before`/`after` carry changed fields, never a snapshot: a full copy would make the audit trail a
 * second store of the data it describes, with no soft delete and no retention policy.
 */
function previousOf<TRow extends object>(
  current: TRow,
  patch: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const values = current as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(patch)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => [key, values[key]]),
  );
}
