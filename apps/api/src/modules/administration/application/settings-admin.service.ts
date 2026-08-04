import { Inject, Injectable } from '@nestjs/common';

import {
  ALL_SETTINGS,
  type AnyId,
  AuditSubjectType,
  type SettingDefinition,
  asId,
  resolveSettings,
  settingFor,
} from '@edms/domain';

import { AdministeredWriter, AdministrativeOperation } from '../../../core/persistence';
import { ValidationError } from '../../../core/errors/application-errors';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../core/outbox/outbox.port';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { AdministrationAudit } from '../domain/audit-actions';
import { settingsChangedEvent } from '../domain/events';
import { TENANT_SETTINGS_REPOSITORY, type TenantSettingsRepository } from './ports';

/** One setting, resolved, as the administration screen renders it. */
export interface SettingRow {
  readonly key: string;
  readonly description: string;
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly isOverridden: boolean;
  readonly kind: 'string' | 'integer' | 'boolean' | 'choice';
  readonly allowed?: readonly string[];
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface SettingsView {
  readonly data: readonly SettingRow[];
  readonly diagnostics: {
    readonly fellBack: readonly string[];
    readonly unrecognised: readonly string[];
  };
}

/**
 * The administration surface over tenant settings.
 *
 * Phase 1 built the read path — `SETTINGS_READER`, cached, never failing. This is the write path, and
 * four things about it are deliberate:
 *
 * **One key per request.** `jsonb_set` merges in the database, so two administrators saving different
 * settings at the same time cannot drop each other's change. A whole-bag `PUT` would read, modify and
 * write, and the later write would silently discard the earlier one.
 *
 * **A value the catalogue rejects is a 422, not a default.** The *reader* falls back to the default
 * for a malformed stored value, because reads sit on paths that must keep working. A *write* has a
 * person waiting for an answer, and telling them "saved" while storing something the reader will
 * ignore is the worst of both.
 *
 * **Resetting removes the override rather than writing the default.** A stored copy of today's default
 * would silently stop tracking it when the product's opinion changed.
 *
 * **The cache is invalidated by the writer.** In-process immediately, and across processes on
 * `administration.settings-changed` once a dispatcher runs; until then the reader's TTL bounds how
 * long another process can hold a stale value.
 */
@Injectable()
export class SettingsAdminService {
  constructor(
    @Inject(TENANT_SETTINGS_REPOSITORY) private readonly settings: TenantSettingsRepository,
    @Inject(SETTINGS_READER) private readonly reader: SettingsReader,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    private readonly writer: AdministeredWriter,
  ) {}

  /**
   * Every setting, resolved, with the diagnostics that say which are not being honoured.
   *
   * Surfaced rather than swallowed: a setting quietly falling back to its default is a tenant running
   * on a configuration they did not choose, and the only place that is visible is here.
   */
  async all(): Promise<SettingsView> {
    const stored = await this.settings.readAll();
    const resolved = resolveSettings(stored);

    return {
      data: ALL_SETTINGS.map((definition) => this.describe(definition, stored, resolved.values)),
      diagnostics: { fellBack: resolved.fellBack, unrecognised: resolved.unrecognised },
    };
  }

  async set(key: string, value: unknown): Promise<SettingRow> {
    const definition = settingFor(key);
    if (definition === null) {
      // A key outside the catalogue cannot be read back by anything, so storing it would only grow a
      // column nobody can enumerate. The repository refuses it too; refusing here names the field.
      throw new ValidationError('That setting does not exist.', [{ field: 'key', message: key }]);
    }

    const parsed = definition.parse(value);
    if (parsed === null) {
      // Out of bounds is rejected rather than clamped: a stored 2 where the minimum password length
      // is 8 is somebody's mistake, and silently honouring 8 would hide it.
      throw new ValidationError('That value is not acceptable for this setting.', [
        { field: 'value', message: definition.description },
      ]);
    }

    return this.writer.write(async () => {
      const before = await this.settings.get<unknown>(key);
      await this.settings.set(key, parsed);
      await this.afterChange([key]);

      return {
        result: await this.one(key),
        change: {
          action: AdministrationAudit.SETTING_CHANGED,
          subjectType: AuditSubjectType.CONFIGURATION,
          subjectId: asId<AnyId>(requireContext().tenantId),
          operation: AdministrativeOperation.UPDATED,
          // The key and both values. Settings are configuration rather than content, and "who
          // shortened the minimum password length" is a question worth being able to answer.
          before: { key, value: before },
          after: { key, value: parsed },
        },
      };
    });
  }

  /**
   * Returns a setting to the product's default by removing the tenant's override.
   *
   * Removing rather than writing the default: a stored copy of today's default would stop tracking it
   * the day the product's opinion changed, and nothing would say why this tenant was different.
   */
  async reset(key: string): Promise<SettingRow> {
    const definition = settingFor(key);
    if (definition === null) {
      throw new ValidationError('That setting does not exist.', [{ field: 'key', message: key }]);
    }

    return this.writer.write(async () => {
      const before = await this.settings.get<unknown>(key);
      await this.settings.remove(key);
      await this.afterChange([key]);

      return {
        result: await this.one(key),
        change: {
          action: AdministrationAudit.SETTING_CHANGED,
          subjectType: AuditSubjectType.CONFIGURATION,
          subjectId: asId<AnyId>(requireContext().tenantId),
          operation: AdministrativeOperation.UPDATED,
          before: { key, value: before },
          after: { key, value: definition.defaultValue, usingDefault: true },
        },
      };
    });
  }

  // --- Internals -------------------------------------------------------------------------

  private async one(key: string): Promise<SettingRow> {
    const view = await this.all();
    const row = view.data.find((entry) => entry.key === key);
    if (!row) {
      // Unreachable: `key` was narrowed against the catalogue before the write, and `all()` renders
      // every catalogue entry. Throwing rather than returning a fabricated row keeps that true.
      throw new ValidationError('That setting does not exist.', [{ field: 'key', message: key }]);
    }
    return row;
  }

  private async afterChange(keys: readonly string[]): Promise<void> {
    const { tenantId } = requireContext();
    // This process, immediately.
    await this.reader.invalidate(tenantId);
    // Every other process, when a dispatcher runs. Published inside the transaction, so an
    // invalidation is never sent for a change that then rolled back.
    await this.outbox.publish([settingsChangedEvent(asId<AnyId>(tenantId), { keys })]);
  }

  /**
   * Describes a setting for a screen, straight from the catalogue.
   *
   * `kind`, `allowed` and `bounds` are declared on the definition rather than inferred here, so
   * adding a setting to the catalogue is the whole of adding it: there is no second table of "which
   * control renders this" to forget, and no screen validating against bounds it restated.
   */
  private describe(
    definition: SettingDefinition<unknown>,
    stored: Readonly<Record<string, unknown>>,
    resolved: Readonly<Record<string, unknown>>,
  ): SettingRow {
    return {
      key: definition.key,
      description: definition.description,
      value: resolved[definition.key],
      defaultValue: definition.defaultValue,
      // Whether the tenant has stored anything for this key — not whether the resolved value differs
      // from the default. Those are different questions, and comparing values is wrong for any
      // setting whose value is not a primitive, where equality is not identity.
      isOverridden: Object.hasOwn(stored, definition.key),
      kind: definition.kind,
      ...(definition.allowed && { allowed: definition.allowed }),
      ...(definition.bounds && {
        minimum: definition.bounds.min,
        maximum: definition.bounds.max,
      }),
    };
  }
}
