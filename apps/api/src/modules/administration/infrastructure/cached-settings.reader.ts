import { Inject, Injectable } from '@nestjs/common';

import { type SettingDefinition, type TenantId, resolveSettings } from '@edms/domain';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import type { SettingsReader } from '../../../core/settings/settings.port';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { CACHE_PORT, type CachePort } from '../../../ports/cache.port';
import { TENANT_SETTINGS_REPOSITORY, type TenantSettingsRepository } from '../application/ports';

/** Long enough to be worth caching, short enough that a missed invalidation self-heals. */
const CACHE_TTL_SECONDS = 300;
const CACHE_PREFIX = 'settings:';

/**
 * Reads tenant settings, resolved against the catalogue and cached.
 *
 * The cache is an optimisation only: a cold cache produces the same answer, never a different
 * one. What is cached is the *resolved* bag rather than the stored one, so a cache hit skips
 * parsing as well as the query — and so a value that failed to parse is not re-logged on every
 * read for five minutes.
 *
 * Nothing here can throw for bad data. A stored value that no longer parses falls back to its
 * default and is logged once; settings are read on paths that must keep working, and an
 * endpoint that fails because someone stored a string where a number belongs is a worse
 * outcome than one that quietly uses the product's own answer.
 */
@Injectable()
export class CachedSettingsReader implements SettingsReader {
  constructor(
    @Inject(TENANT_SETTINGS_REPOSITORY) private readonly repository: TenantSettingsRepository,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async get<TValue>(definition: SettingDefinition<TValue>): Promise<TValue> {
    const resolved = await this.all();
    // Resolution already guaranteed a valid value for every declared setting, so the cast is
    // safe by construction rather than by hope: `resolveSettings` writes the default whenever
    // the stored value did not parse.
    return resolved[definition.key] as TValue;
  }

  async all(): Promise<Readonly<Record<string, unknown>>> {
    const { tenantId } = requireContext();
    const cacheKey = `${CACHE_PREFIX}${tenantId}`;

    const cached = await this.cache.get<Record<string, unknown>>(cacheKey);
    if (cached) {
      return cached;
    }

    const { values, fellBack, unrecognised } = resolveSettings(await this.readStored());

    for (const key of fellBack) {
      this.logger.warn('Stored setting could not be used; default applied', { key, tenantId });
    }
    for (const key of unrecognised) {
      // Present in the column, absent from the catalogue: left behind by an older release, or
      // hand-written. Harmless, but somebody should know.
      this.logger.warn('Stored setting is not in the catalogue', { key, tenantId });
    }

    await this.cache.set(cacheKey, values, CACHE_TTL_SECONDS);
    return values;
  }

  async invalidate(tenantId: TenantId): Promise<void> {
    await this.cache.delete(`${CACHE_PREFIX}${tenantId}`);
  }

  /**
   * A failure to read settings is not a failure to serve the request.
   *
   * If the database is unreachable the caller gets product defaults rather than an exception.
   * That is the right trade for configuration: a request served with default settings is
   * degraded, and a request not served at all is an outage.
   */
  private async readStored(): Promise<Readonly<Record<string, unknown>>> {
    try {
      return await this.repository.readAll();
    } catch (error) {
      this.logger.error('Could not read tenant settings; falling back to defaults', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      return {};
    }
  }
}
