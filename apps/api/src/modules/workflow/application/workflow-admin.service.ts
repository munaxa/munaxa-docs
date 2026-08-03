import { Inject, Injectable } from '@nestjs/common';

import { type AnyId, AuditSubjectType, WorkflowVersionState, asId } from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  AdministeredWriter,
  AdministrativeOperation,
  type AdministrativeOperationKey,
  checkVersion as checkRecordVersion,
  requireVersion,
} from '../../../core/persistence';
import {
  DuplicateError,
  NotFoundError,
  ValidationError,
} from '../../../core/errors/application-errors';
import { WorkflowAudit } from '../domain/audit-actions';
import {
  EVALUABLE_CONDITION_FIELDS,
  type DefinitionShape,
  checkVersion,
} from '../domain/version-validator';
import {
  WORKFLOW_ADMIN_REPOSITORY,
  type WorkflowAdminRepository,
  type WorkflowDefinitionRow,
  type WorkflowListRequest,
  type WorkflowVersionRow,
} from './administration.ports';

/**
 * Administering approval workflows.
 *
 * The engine is not here — nothing starts an instance or decides a task — but the property the engine
 * depends on most is, and it is the whole reason this module's administration is not ordinary CRUD:
 *
 * **A published version is immutable.** An instance binds to a *version*, so editing one would change
 * the rules of an approval already running, which `07-workflow-architecture.md` §1 calls the single
 * most important property of the engine. Editing a live workflow therefore means creating a new draft
 * and publishing it; the running approvals keep the version they started under, forever.
 *
 * Three consequences follow, and each is a method below rather than a convention:
 *
 * - Only a `DRAFT` accepts an edit. Anything else is refused, not silently copied.
 * - Publishing deprecates whatever was published before, so exactly one version is live and "which
 *   rules apply to a new submission" has one answer.
 * - A definition in use is never deleted, only deprecated. Instances keep their version forever, and a
 *   removed version is one a running approval could not read.
 *
 * The validator runs at **publish**, and also at save. A draft may legitimately be incomplete while
 * somebody is building it; the moment it becomes the rules an approval runs by, it may not be.
 */
@Injectable()
export class WorkflowAdminService {
  constructor(
    @Inject(WORKFLOW_ADMIN_REPOSITORY) private readonly workflows: WorkflowAdminRepository,
    private readonly writer: AdministeredWriter,
  ) {}

  list(request: WorkflowListRequest): Promise<Page<WorkflowDefinitionRow>> {
    return this.writer.read(() => this.workflows.list(request));
  }

  get(id: string): Promise<WorkflowDefinitionRow> {
    return this.writer.read(() => this.require(id, true));
  }

  async create(input: {
    key: string;
    name: string;
    description?: string | undefined;
    definition: DefinitionShape;
  }): Promise<WorkflowDefinitionRow> {
    const key = input.key.trim().toLowerCase();
    const name = this.requireName(input.name);
    // Checked on the way in as well as at publish. A draft may be incomplete, but it may not be
    // incoherent in a way nothing would ever accept — refusing now saves somebody from building on it.
    this.refuseUnpublishable(input.definition);

    return this.writer.write(async () => {
      if (await this.workflows.keyTaken(key, null)) {
        throw new DuplicateError('workflow', 'key');
      }

      const definitionId = this.writer.clock.nextId();
      const versionId = this.writer.clock.nextId();
      await this.workflows.insertWithFirstVersion({
        definitionId,
        versionId,
        key,
        name,
        description: input.description === undefined ? null : squish(input.description),
        definition: input.definition,
      });

      return {
        result: await this.require(definitionId, false),
        change: this.changed(definitionId, AdministrativeOperation.CREATED, undefined, {
          key,
          name,
          stages: input.definition.stages.length,
        }),
      };
    });
  }

  async update(
    id: string,
    patch: { name?: string; description?: string | null; isActive?: boolean },
    expectedVersion: number | undefined,
  ): Promise<WorkflowDefinitionRow> {
    return this.writer.write(async () => {
      const current = await this.require(id, false);
      checkRecordVersion(expectedVersion, current.recordVersion);

      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      await this.workflows.update(id, current.recordVersion, {
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && {
          description: patch.description === null ? null : squish(patch.description),
        }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      });

      return {
        result: await this.require(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.UPDATED,
          {
            ...(name !== undefined && { name: current.name }),
            ...(patch.isActive !== undefined && { isActive: current.isActive }),
          },
          {
            ...(name !== undefined && { name }),
            ...(patch.isActive !== undefined && { isActive: patch.isActive }),
          },
        ),
      };
    });
  }

  /**
   * Starts a new draft.
   *
   * This is what "editing a published workflow" actually is. The body is supplied rather than copied
   * from the live version, because the client already has that version rendered in a builder — and
   * copying server-side would mean two paths to the same draft, one of which nobody exercises.
   */
  async addDraft(
    definitionId: string,
    definition: DefinitionShape,
  ): Promise<WorkflowDefinitionRow> {
    this.refuseUnpublishable(definition);

    return this.writer.write(async () => {
      const current = await this.require(definitionId, false);
      const versionId = this.writer.clock.nextId();
      const number = await this.workflows.insertVersion({ definitionId, versionId, definition });

      return {
        result: await this.require(definitionId, false),
        change: this.changed(definitionId, AdministrativeOperation.CREATED, undefined, {
          versionId,
          version: number,
          state: WorkflowVersionState.DRAFT,
          basedOnPublished: current.publishedVersion,
        }),
      };
    });
  }

  /** Replaces a draft's body. A published or deprecated version is refused, never copied. */
  async updateDraft(
    definitionId: string,
    versionId: string,
    definition: DefinitionShape,
  ): Promise<WorkflowDefinitionRow> {
    this.refuseUnpublishable(definition);

    return this.writer.write(async () => {
      await this.require(definitionId, false);
      const version = await this.requireVersionRow(definitionId, versionId);
      this.refuseUnlessDraft(version);

      await this.workflows.updateDraft(versionId, definition);

      return {
        result: await this.require(definitionId, false),
        change: this.changed(definitionId, AdministrativeOperation.UPDATED, undefined, {
          versionId,
          version: version.version,
          stages: definition.stages.length,
        }),
      };
    });
  }

  /**
   * Publishes a draft, making it the version new approvals bind to.
   *
   * The version is required, and it is the *definition record's* version rather than the workflow
   * version number: publishing is irreversible — the draft becomes immutable — so it may not be done
   * against a state the caller has not seen.
   */
  async publish(
    definitionId: string,
    versionId: string,
    expectedVersion: number | undefined,
  ): Promise<WorkflowDefinitionRow> {
    return this.writer.write(async () => {
      const current = await this.require(definitionId, false);
      requireVersion(expectedVersion, current.recordVersion);

      const version = await this.requireVersionRow(definitionId, versionId);
      this.refuseUnlessDraft(version);
      // Re-validated at publish even though it was validated at save. This is the moment it becomes the
      // rules an approval runs by, and the catalogue it is validated against — the condition fields the
      // evaluator can resolve — can have changed since the draft was written.
      this.refuseUnpublishable(version.definition as DefinitionShape);

      const at = this.writer.clock.now();
      await this.workflows.publish(versionId, at, current.updatedBy);
      // Exactly one live version, so "which rules apply to a new submission" has one answer. The
      // previous one becomes DEPRECATED rather than disappearing: instances bound to it keep reading it.
      await this.workflows.deprecateOthers(definitionId, versionId);

      return {
        result: await this.require(definitionId, false),
        change: {
          action: WorkflowAudit.WORKFLOW_PUBLISHED,
          subjectType: AuditSubjectType.WORKFLOW,
          subjectId: asId<AnyId>(definitionId),
          operation: AdministrativeOperation.UPDATED,
          before: { publishedVersion: current.publishedVersion },
          after: { publishedVersion: version.version, versionId },
        },
      };
    });
  }

  /**
   * Retires a version.
   *
   * New approvals stop using it; running ones are untouched, which is why this is not a delete. A
   * definition in use cannot be removed at all — §7 — and deprecating is what "removing" means for one.
   */
  async deprecate(
    definitionId: string,
    versionId: string,
    expectedVersion: number | undefined,
  ): Promise<WorkflowDefinitionRow> {
    return this.writer.write(async () => {
      const current = await this.require(definitionId, false);
      requireVersion(expectedVersion, current.recordVersion);
      const version = await this.requireVersionRow(definitionId, versionId);

      if (version.state === WorkflowVersionState.DEPRECATED) {
        // Idempotent: two administrators retiring the same version both want the end state.
        return {
          result: await this.require(definitionId, false),
          change: this.changed(definitionId, AdministrativeOperation.UPDATED, undefined, {
            versionId,
            alreadyDeprecated: true,
          }),
        };
      }

      await this.workflows.deprecate(versionId);

      return {
        result: await this.require(definitionId, false),
        change: this.changed(
          definitionId,
          AdministrativeOperation.UPDATED,
          { state: version.state },
          { versionId, state: WorkflowVersionState.DEPRECATED },
        ),
      };
    });
  }

  /**
   * Soft-deletes a definition nothing uses.
   *
   * "Uses" means two things, and both block: a document type attached to it, and any version that has
   * ever been published. The second is the stricter one and it is deliberate — a published version may
   * have instances bound to it, and §7 says a definition in use cannot be deleted, only deprecated.
   */
  async delete(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(id, false);
      requireVersion(expectedVersion, current.recordVersion);

      const attached = await this.workflows.countAttachedTypes(id);
      if (attached > 0) {
        throw new ValidationError('A document type still uses this workflow. Retire it instead.', [
          { field: 'documentTypeCount', message: String(attached) },
        ]);
      }
      const everPublished = current.versions.some(
        (version) => version.state !== WorkflowVersionState.DRAFT,
      );
      if (everPublished) {
        throw new ValidationError(
          'This workflow has been published and may have approvals bound to it. Retire it instead.',
          [{ field: 'versions', message: 'published' }],
        );
      }

      await this.workflows.setDeleted(id, current.recordVersion, true);

      return {
        result: undefined,
        change: this.changed(
          id,
          AdministrativeOperation.DELETED,
          { deletedAt: null },
          {
            key: current.key,
          },
        ),
      };
    });
  }

  async restore(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(id, true);
      checkRecordVersion(expectedVersion, current.recordVersion);
      if (current.deletedAt === null) {
        return {
          result: undefined,
          change: this.changed(id, AdministrativeOperation.RESTORED, undefined, {
            alreadyLive: true,
          }),
        };
      }
      if (await this.workflows.keyTaken(current.key, id)) {
        throw new DuplicateError('workflow', 'key');
      }

      await this.workflows.setDeleted(id, current.recordVersion, false);

      return {
        result: undefined,
        change: this.changed(
          id,
          AdministrativeOperation.RESTORED,
          {
            deletedAt: current.deletedAt,
          },
          { key: current.key },
        ),
      };
    });
  }

  // --- Internals -------------------------------------------------------------------------

  private async require(id: string, includeDeleted: boolean): Promise<WorkflowDefinitionRow> {
    const row = await this.workflows.find(id, includeDeleted);
    if (!row) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  private async requireVersionRow(
    definitionId: string,
    versionId: string,
  ): Promise<WorkflowVersionRow> {
    const row = await this.workflows.findVersion(definitionId, versionId);
    if (!row) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  private refuseUnlessDraft(version: WorkflowVersionRow): void {
    if (version.state !== WorkflowVersionState.DRAFT) {
      // Not copied into a new draft implicitly. An edit that silently became a different version would
      // leave the caller believing they had changed the one they were looking at.
      throw new ValidationError(
        'A published version cannot be changed. Create a new draft instead.',
        [{ field: 'state', message: version.state }],
      );
    }
  }

  private refuseUnpublishable(definition: DefinitionShape): void {
    const rejections = checkVersion(definition);
    if (rejections.length === 0) {
      return;
    }
    throw new ValidationError(
      `That workflow cannot be used to approve anything. Conditions may test: ${EVALUABLE_CONDITION_FIELDS.join(', ')}.`,
      rejections.map((reason) => ({ field: 'definition', message: reason })),
    );
  }

  private requireName(raw: string): string {
    const name = squish(raw);
    if (name.length === 0) {
      throw new ValidationError('A name is required.', [{ field: 'name', message: 'required' }]);
    }
    return name;
  }

  private changed(
    id: string,
    operation: AdministrativeOperationKey,
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return {
      action: WorkflowAudit.WORKFLOW_CHANGED,
      subjectType: AuditSubjectType.WORKFLOW,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before && { before }),
      ...(after && { after }),
    };
  }
}
