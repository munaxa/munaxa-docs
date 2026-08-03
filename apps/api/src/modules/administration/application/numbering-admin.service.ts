import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  AuditSubjectType,
  NumberSegmentKind,
  type SequenceResetScopeKey,
  asId,
} from '@edms/domain';
import { type Page, squish } from '@edms/utils';

import {
  AdministeredWriter,
  AdministrativeOperation,
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
import { numberingRuleChangedEvent } from '../domain/events';
import {
  type FormattedNumber,
  type NumberSegment,
  type NumberingContext,
  PREVIEW_PLACEHOLDERS,
  PREVIEW_SEQUENCE_VALUE,
  checkRule,
  formatNumber,
} from '../domain/numbering';
import {
  CONFIGURATION_REPOSITORY,
  type ConfigListRequest,
  ConfigurationKind,
  type ConfigurationRepository,
  type NumberingRuleRow,
} from './administration.ports';

/**
 * Configuring how documents are numbered.
 *
 * A document number is an external identifier — it appears in printed copies, contracts and other
 * systems — so it is issued once, never changes, and is never reused. Everything here follows from
 * that, and two rules are the whole reason this is not ordinary CRUD:
 *
 * **Padding cannot widen once a series exists.** A rule that has issued `0042` and then widens to five
 * digits would give one number two written forms, `0042` and `00042`, which is the same defect as
 * reusing it. A new rule is created instead (§1).
 *
 * **Editing a rule never renumbers anything.** Numbers are stored, not computed, so an edit affects
 * only documents numbered afterwards. The event says so; nothing recalculates.
 *
 * Previewing is a `POST` that claims nothing. The builder renders a sample from an *unsaved* rule, so
 * there is nothing to `GET` — and drawing a real number to show a preview would burn one.
 */
@Injectable()
export class NumberingAdminService {
  constructor(
    @Inject(CONFIGURATION_REPOSITORY) private readonly config: ConfigurationRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  list(request: ConfigListRequest): Promise<Page<NumberingRuleRow>> {
    return this.writer.read(() => this.config.listNumberingRules(request));
  }

  get(id: string): Promise<NumberingRuleRow> {
    return this.writer.read(() => this.require(id, true));
  }

  async create(input: {
    key: string;
    name: string;
    description?: string | undefined;
    separator: string;
    segments: readonly NumberSegment[];
    resetScope: readonly SequenceResetScopeKey[];
    reserveOnSubmit: boolean;
    strictGapless: boolean;
  }): Promise<NumberingRuleRow> {
    const key = input.key.trim().toLowerCase();
    const name = this.requireName(input.name);
    this.refuseBadRule(input);

    return this.writer.write(async () => {
      if (await this.config.numberingRuleKeyTaken(key, null)) {
        throw new DuplicateError('numbering rule', 'key');
      }

      const id = this.writer.clock.nextId();
      await this.config.insertNumberingRule({
        id,
        key,
        name,
        description: input.description === undefined ? null : squish(input.description),
        separator: input.separator,
        segments: input.segments,
        resetScope: input.resetScope,
        reserveOnSubmit: input.reserveOnSubmit,
        strictGapless: input.strictGapless,
      });

      return {
        result: await this.require(id, false),
        change: this.changed(id, AdministrativeOperation.CREATED, undefined, {
          key,
          separator: input.separator,
          segments: input.segments,
          resetScope: input.resetScope,
        }),
      };
    });
  }

  async update(
    id: string,
    patch: Partial<{
      name: string;
      description: string | null;
      separator: string;
      segments: readonly NumberSegment[];
      resetScope: readonly SequenceResetScopeKey[];
      reserveOnSubmit: boolean;
      strictGapless: boolean;
    }>,
    expectedVersion: number | undefined,
  ): Promise<NumberingRuleRow> {
    const changesShape =
      patch.segments !== undefined ||
      patch.separator !== undefined ||
      patch.resetScope !== undefined;

    return this.writer.write(async () => {
      const current = await this.require(id, false);
      // A shape change decides the identifiers printed on every document numbered afterwards, and the
      // previous shape is not recoverable from the new one. It may not be written blind.
      if (changesShape) {
        requireVersion(expectedVersion, current.version);
      } else {
        checkVersion(expectedVersion, current.version);
      }

      const merged = {
        separator: patch.separator ?? current.separator,
        segments: patch.segments ?? current.segments,
        resetScope: patch.resetScope ?? current.resetScope,
        reserveOnSubmit: patch.reserveOnSubmit ?? current.reserveOnSubmit,
        strictGapless: patch.strictGapless ?? current.strictGapless,
      };
      // Validated as a whole rather than field by field: whether a rule is coherent depends on the
      // combination — an optional segment is only ambiguous alongside another one.
      this.refuseBadRule(merged);

      if (patch.segments !== undefined && current.sequenceCount > 0) {
        this.refusePaddingChange(current.segments, patch.segments);
      }

      const name = patch.name === undefined ? undefined : this.requireName(patch.name);
      await this.config.updateNumberingRule(id, current.version, {
        ...(name !== undefined && { name }),
        ...(patch.description !== undefined && {
          description: patch.description === null ? null : squish(patch.description),
        }),
        ...(patch.separator !== undefined && { separator: patch.separator }),
        ...(patch.segments !== undefined && { segments: patch.segments }),
        ...(patch.resetScope !== undefined && { resetScope: patch.resetScope }),
        ...(patch.reserveOnSubmit !== undefined && { reserveOnSubmit: patch.reserveOnSubmit }),
        ...(patch.strictGapless !== undefined && { strictGapless: patch.strictGapless }),
      });

      if (changesShape) {
        // "Never renumbers anything that exists." The event exists so a consumer holding a rendered
        // sample reconsiders it; the numbers already issued are stored and are not touched.
        await this.outbox.publish([
          numberingRuleChangedEvent(asId<AnyId>(id), {
            numberingRuleId: id,
            affectsDocumentTypeIds: [],
          }),
        ]);
      }

      return {
        result: await this.require(id, false),
        change: this.changed(
          id,
          AdministrativeOperation.UPDATED,
          {
            ...(patch.separator !== undefined && { separator: current.separator }),
            ...(patch.segments !== undefined && { segments: current.segments }),
            ...(patch.resetScope !== undefined && { resetScope: current.resetScope }),
          },
          {
            ...(patch.separator !== undefined && { separator: patch.separator }),
            ...(patch.segments !== undefined && { segments: patch.segments }),
            ...(patch.resetScope !== undefined && { resetScope: patch.resetScope }),
          },
        ),
      };
    });
  }

  async delete(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.write(async () => {
      const current = await this.require(id, false);
      requireVersion(expectedVersion, current.version);

      const dependents = await this.config.dependentsOf(ConfigurationKind.NUMBERING_RULE, id);
      const blocking = Object.entries(dependents).filter(([, count]) => count > 0);
      if (blocking.length > 0) {
        throw new ValidationError(
          'Something still uses this rule. Change or remove it first.',
          blocking.map(([what, count]) => ({ field: what, message: String(count) })),
        );
      }

      await this.config.setDeleted(ConfigurationKind.NUMBERING_RULE, id, current.version, true);

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
      checkVersion(expectedVersion, current.version);
      if (current.deletedAt === null) {
        return {
          result: undefined,
          change: this.changed(id, AdministrativeOperation.RESTORED, undefined, {
            alreadyLive: true,
          }),
        };
      }
      if (await this.config.numberingRuleKeyTaken(current.key, id)) {
        throw new DuplicateError('numbering rule', 'key');
      }

      await this.config.setDeleted(ConfigurationKind.NUMBERING_RULE, id, current.version, false);

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

  /**
   * Renders a sample from a rule that may not exist yet.
   *
   * Pure and side-effect free — no transaction, no sequence claimed, nothing audited. It is a
   * calculator, and the builder calls it on every keystroke.
   */
  preview(input: {
    separator: string;
    segments: readonly NumberSegment[];
    context: Omit<NumberingContext, 'assignedAt'>;
  }): FormattedNumber {
    const context: NumberingContext = {
      // Placeholders where the caller gave nothing, so a sample reads as a sample. Rendering an empty
      // string would show a gap between separators that an administrator cannot interpret.
      companyCode: input.context.companyCode ?? PREVIEW_PLACEHOLDERS['companyCode'],
      entityCode: input.context.entityCode ?? PREVIEW_PLACEHOLDERS['entityCode'],
      branchCode: input.context.branchCode ?? PREVIEW_PLACEHOLDERS['branchCode'],
      departmentCode: input.context.departmentCode ?? PREVIEW_PLACEHOLDERS['departmentCode'],
      documentTypeCode: input.context.documentTypeCode ?? PREVIEW_PLACEHOLDERS['documentTypeCode'],
      categoryCode: input.context.categoryCode ?? PREVIEW_PLACEHOLDERS['categoryCode'],
      // The clock, not `new Date()`: a preview showing a year is showing what the *product* thinks
      // the year is, and a test that freezes time must see a stable sample.
      assignedAt: this.writer.clock.now(),
    };

    return formatNumber(
      { separator: input.separator, segments: input.segments, resetScope: [] },
      context,
      PREVIEW_SEQUENCE_VALUE,
    );
  }

  /** The stored rule's own sample, for a list that shows what each rule produces. */
  sampleFor(rule: NumberingRuleRow): string {
    return this.preview({ separator: rule.separator, segments: rule.segments, context: {} })
      .formatted;
  }

  // --- Internals -------------------------------------------------------------------------

  private async require(id: string, includeDeleted: boolean): Promise<NumberingRuleRow> {
    const row = await this.config.findNumberingRule(id, includeDeleted);
    if (!row) {
      throw new NotFoundError('The requested resource');
    }
    return row;
  }

  private refuseBadRule(rule: {
    separator: string;
    segments: readonly NumberSegment[];
    resetScope: readonly SequenceResetScopeKey[];
    reserveOnSubmit?: boolean;
    strictGapless?: boolean;
  }): void {
    const rejections = checkRule(rule);
    if (rejections.length > 0) {
      // Every reason, so an administrator building a rule sees what is wrong with it rather than
      // discovering the next problem after fixing this one.
      throw new ValidationError(
        'That rule cannot be used to issue a number.',
        rejections.map((reason) => ({ field: 'segments', message: reason })),
      );
    }
  }

  /**
   * Refuses a padding change on a rule that has already issued numbers.
   *
   * A rule with a live sequence has drawn at least one value. Widening the padding would give that
   * value two written forms; narrowing it would collide the moment the counter passed the new width.
   * Either way one number would have two textual identities, which is the same defect as reusing one
   * (§1).
   */
  private refusePaddingChange(
    before: readonly NumberSegment[],
    after: readonly NumberSegment[],
  ): void {
    const paddingOf = (segments: readonly NumberSegment[]): number | null => {
      const sequence = segments.find((segment) => segment.kind === NumberSegmentKind.SEQUENCE);
      return sequence !== undefined && sequence.kind === NumberSegmentKind.SEQUENCE
        ? (sequence.padding ?? 4)
        : null;
    };

    const was = paddingOf(before);
    const is = paddingOf(after);
    if (was !== null && is !== null && was !== is) {
      throw new ValidationError(
        'This rule has already issued numbers, so the number of digits cannot change. Create a new rule instead.',
        [{ field: 'segments', message: 'PADDING_LOCKED' }],
      );
    }
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
    operation: (typeof AdministrativeOperation)[keyof typeof AdministrativeOperation],
    before: Readonly<Record<string, unknown>> | undefined,
    after: Readonly<Record<string, unknown>> | undefined,
  ) {
    return {
      action: AdministrationAudit.RULE_CHANGED,
      subjectType: AuditSubjectType.CONFIGURATION,
      subjectId: asId<AnyId>(id),
      operation,
      ...(before && { before }),
      ...(after && { after }),
    };
  }
}
