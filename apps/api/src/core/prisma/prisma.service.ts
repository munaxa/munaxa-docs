import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { APP_CONFIG, type AppConfig } from '../config';
import { LOGGER, type Logger } from '../observability/logger';

/**
 * The database client, and the place the tenant is stamped onto every statement.
 *
 * Isolation layer 4 lives in `tenantScoped()`: a query issued through it carries the
 * request's tenant in a session setting, which is what the RLS policies read
 * (`docs/architecture/05-database-design.md` §2). The application connects as a role
 * *without* `BYPASSRLS`, so a forgotten `where` clause returns nothing rather than
 * another tenant's rows.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    super({ datasources: { db: { url: config.database.url } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.info('Database connected', { poolSize: this.config.database.poolSize });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Runs `work` inside a transaction whose session carries `app.tenant_id`, so every
   * statement it issues is subject to the tenant's row-level security policies.
   *
   * `set_config(..., true)` is transaction-local: the setting cannot leak to the next
   * borrower of a pooled connection, which is the failure mode that makes session-level
   * tenant settings unsafe.
   */
  async withTenant<TResult>(
    tenantId: string,
    work: (tx: PrismaTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.tenant_id', $1, true)", tenantId);
      return work(tx);
    });
  }

  async ping(): Promise<void> {
    await this.$queryRawUnsafe('SELECT 1');
  }
}

/**
 * The handle a repository receives. Typed as the transactional client so a repository
 * cannot start a transaction of its own — the use case owns the boundary
 * (`docs/architecture/02-backend-architecture.md` §5).
 */
export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
