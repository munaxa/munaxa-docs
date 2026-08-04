import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { TenantStatus } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../config';
import { NotFoundError } from '../errors/application-errors';
import { LOGGER, type Logger } from '../observability/logger';
import { TENANT_REGISTRY, type TenantRegistry } from '../tenancy/tenant-registry.port';
import type { TenantPlacement } from '../tenancy/tenant-placement';

/**
 * The databases, one per tenant, and the place a tenant is turned into a connection.
 *
 * This replaces the single client Phase 1 shipped. The change it makes is small to read and total in
 * effect: `withTenant` resolves the tenant's placement through the registry and opens the transaction
 * on *that* tenant's database. No repository, service or use case moved
 * ([ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 *
 * Isolation is now structural. A forgotten `where tenant_id = …` used to be a cross-tenant read
 * prevented by RLS; it is now a query against a database that physically does not contain the other
 * tenant's rows. RLS stays anyway, inside every tenant database, because the schema is identical in
 * both deployments and defence in depth costs nothing here — and because it is what keeps a
 * single-database on-premise installation with two tenants honest.
 *
 * ### Clients are cached, bounded, and lazily connected
 *
 * A `PrismaClient` owns a connection pool, so one per tenant is `tenants × poolSize` connections
 * against a `max_connections` that is not negotiable. The cache is therefore bounded by
 * `DATABASE_MAX_TENANT_CLIENTS` and evicts the least recently used, disconnecting it. A single-tenant
 * installation never evicts anything; a busy cloud process pays a reconnect for a tenant it has not
 * served recently, which is the right thing to pay.
 *
 * Connection happens on first use rather than at boot. A cloud process serving four hundred tenants
 * must not open four hundred pools to become ready, and a tenant whose database is temporarily
 * unreachable must not stop the process from serving everybody else.
 */
@Injectable()
export class TenantDatabase implements OnModuleDestroy {
  /**
   * Insertion order is recency order: a hit deletes and re-sets, so the first key is always the least
   * recently used. A `Map` rather than a dependency, because that is the whole of the LRU policy.
   */
  private readonly clients = new Map<string, PrismaClient>();

  /**
   * In-flight connections, so two concurrent requests for a cold tenant open one pool rather than two.
   * A rejected attempt is removed, so the next request retries instead of inheriting the failure.
   */
  private readonly connecting = new Map<string, Promise<PrismaClient>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.disconnectAll();
  }

  /**
   * Runs `work` inside a transaction on the tenant's own database, with `app.tenant_id` set.
   *
   * The session setting is transaction-local (`set_config(..., true)`), so it cannot leak to the next
   * borrower of a pooled connection — the failure mode that makes session-level tenant settings
   * unsafe. It is still set even though the database holds one tenant's rows: the RLS policies read
   * it, and a policy that silently passed because nothing set the variable would be a policy nobody
   * notices has stopped working.
   */
  async withTenant<TResult>(
    tenantId: string,
    work: (tx: PrismaTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    const client = await this.clientFor(tenantId);
    return client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
      return work(tx);
    });
  }

  /**
   * The client for a tenant, connected.
   *
   * Public because three callers legitimately need a client outside a transaction: the settings
   * reader, provisioning, and the health check. Everything else goes through `UnitOfWork`.
   */
  async clientFor(tenantId: string): Promise<PrismaClient> {
    const cached = this.clients.get(tenantId);
    if (cached) {
      // Touch, so the most recently used tenant is never the one evicted.
      this.clients.delete(tenantId);
      this.clients.set(tenantId, cached);
      return cached;
    }

    const inFlight = this.connecting.get(tenantId);
    if (inFlight) {
      return inFlight;
    }

    const attempt = this.open(tenantId).finally(() => {
      this.connecting.delete(tenantId);
    });
    this.connecting.set(tenantId, attempt);
    return attempt;
  }

  /** Every tenant this process could serve. For the health check, which reports each separately. */
  placements(): Promise<readonly TenantPlacement[]> {
    return this.registry.all();
  }

  async ping(tenantId: string): Promise<void> {
    const client = await this.clientFor(tenantId);
    await client.$queryRawUnsafe('SELECT 1');
  }

  /** Drops a tenant's pool — on shutdown, on eviction, and after its placement changes. */
  async disconnect(tenantId: string): Promise<void> {
    const client = this.clients.get(tenantId);
    if (!client) {
      return;
    }
    this.clients.delete(tenantId);
    await this.quietly(client, tenantId);
  }

  async disconnectAll(): Promise<void> {
    const open = [...this.clients.entries()];
    this.clients.clear();
    await Promise.all(open.map(([tenantId, client]) => this.quietly(client, tenantId)));
  }

  private async open(tenantId: string): Promise<PrismaClient> {
    const placement = await this.registry.byId(tenantId);
    if (!placement) {
      // The same answer as a tenant that never existed. A token signed for a tenant this deployment
      // no longer serves is not a routing problem to explain, it is a request with nowhere to go.
      throw new NotFoundError('The requested resource');
    }
    if (placement.status === TenantStatus.CLOSED) {
      throw new NotFoundError('The requested resource');
    }

    await this.evictIfFull();

    const client = new PrismaClient({ datasources: { db: { url: placement.database.url } } });
    await client.$connect();
    this.clients.set(tenantId, client);
    this.logger.info('Tenant database connected', {
      tenantSlug: placement.slug,
      liveClients: this.clients.size,
      poolSize: this.config.database.poolSize,
    });
    return client;
  }

  private async evictIfFull(): Promise<void> {
    while (this.clients.size >= this.config.database.maxTenantClients) {
      const oldest = this.clients.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.logger.debug('Evicting the least recently used tenant database', {
        liveClients: this.clients.size,
      });
      await this.disconnect(oldest.value);
    }
  }

  /**
   * Disconnects without letting the failure escape.
   *
   * Shutdown and eviction both call this, and in both a failed disconnect is not actionable: the
   * process is going away, or the client is already unreachable. Logged rather than thrown, because
   * an exception here would abandon the *other* clients still waiting to be closed.
   */
  private async quietly(client: PrismaClient, tenantId: string): Promise<void> {
    try {
      await client.$disconnect();
    } catch (error) {
      this.logger.warn('A tenant database did not disconnect cleanly', {
        tenantId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}

/**
 * The handle a repository receives. Typed as the transactional client so a repository cannot start a
 * transaction of its own — the use case owns the boundary
 * (`docs/architecture/02-backend-architecture.md` §5).
 */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
