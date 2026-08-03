import type { SettingDefinition, TenantId } from '@edms/domain';

/**
 * Reading tenant configuration.
 *
 * Declared in `core/` because every module reads settings, and bound by Administration, which
 * owns them — the same split as the audit writer. The catalogue itself lives in `@edms/domain`
 * so that a module can name the setting it needs without importing another module's internals.
 *
 * `get` takes a definition rather than a string key. That is what makes the return type the
 * setting's own type instead of `unknown`, and it means a caller cannot ask for a setting that
 * does not exist — there would be nothing to pass.
 */
export const SETTINGS_READER = Symbol('SettingsReader');

export interface SettingsReader {
  /**
   * The effective value for the current tenant: its override if it has a usable one, the
   * product default otherwise.
   *
   * Never throws for a missing or malformed stored value, and never returns null. Settings are
   * read on paths that must keep working — an endpoint must not fail because someone stored a
   * string where a number belongs.
   */
  get<TValue>(definition: SettingDefinition<TValue>): Promise<TValue>;

  /** Every setting resolved at once, for a screen that renders the lot. */
  all(): Promise<Readonly<Record<string, unknown>>>;

  /**
   * Drops the cached values for a tenant.
   *
   * Called by whatever writes a setting. Cross-process invalidation rides on the
   * `administration.settings-changed` event once the outbox dispatcher exists; until then the
   * cache TTL bounds how long another process can hold a stale value.
   */
  invalidate(tenantId: TenantId): Promise<void>;
}
