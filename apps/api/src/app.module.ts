import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { AuditModule } from './core/audit';
import { AuthModule, AuthenticationGuard, AuthenticationMiddleware } from './core/auth';
import { AuthorizationModule, AclGuard, RbacGuard } from './core/authorization';
import { ConfigModule } from './core/config';
import { AllExceptionsFilter } from './core/errors';
import {
  CorrelationIdMiddleware,
  IdempotencyInterceptor,
  SerializationInterceptor,
} from './core/http';
import { MessagingModule } from './core/messaging';
import { LoggerModule, ObservabilityModule } from './core/observability';
import { OutboxModule } from './core/outbox';
import { PrismaModule } from './core/prisma';
import { TenancyModule, TenantIsolationGuard } from './core/tenancy';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { AdministrationModule } from './modules/administration/administration.module';
import { AuditModule as AuditDomainModule } from './modules/audit/audit.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DocumentModule } from './modules/document/document.module';
import { IdentityModule } from './modules/identity/identity.module';
import { JwtTokenService } from './modules/identity/infrastructure/jwt.token-service';
import { LibraryModule } from './modules/library/library.module';
import { NotificationModule } from './modules/notification/notification.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { PreviewModule } from './modules/preview/preview.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { RetentionModule } from './modules/retention/retention.module';
import { RevisionModule } from './modules/revision/revision.module';
import { SearchModule } from './modules/search/search.module';
import { StorageModule } from './modules/storage/storage.module';
import { WorkflowModule } from './modules/workflow/workflow.module';

/**
 * The composition root.
 *
 * Two things are worth reading carefully here, because they are the API's security posture
 * expressed as code:
 *
 * **The middleware chain**, which establishes identity before anything can use it. The
 * correlation id comes first so that even a request rejected by authentication is traceable;
 * authentication runs as middleware rather than as a guard because it must wrap the rest of
 * the request in the tenant context (`core/auth/authentication.middleware.ts`).
 *
 * **The global guard order**, which is fixed and closed by default: authenticated →
 * not naming another tenant → holds the permission → may reach *this* object. Registering
 * them globally rather than per-controller means a new controller is protected on the day it
 * is written, and a route that wants less must say so explicitly with `@Public(reason)`
 * (`docs/architecture/02-backend-architecture.md` §7).
 */
@Module({
  imports: [
    // Core: cross-cutting, global, imported by everything.
    ConfigModule,
    LoggerModule,
    PrismaModule,
    TenancyModule,
    // Identity ships a real verifier, so the port no longer resolves to the one that rejects
    // everything. This is the only place that may import both `core/` and a module.
    AuthModule.withVerifier(JwtTokenService),
    AuthorizationModule,
    AuditModule,
    OutboxModule,
    MessagingModule,
    InfrastructureModule,
    ObservabilityModule,

    // Domain modules, in dependency order (02-backend-architecture.md §3).
    IdentityModule,
    OrganizationModule,
    AdministrationModule,
    LibraryModule,
    DocumentModule,
    RevisionModule,
    WorkflowModule,
    StorageModule,
    PreviewModule,
    SearchModule,
    AuditDomainModule,
    NotificationModule,
    RetentionModule,
    ReportingModule,
    DashboardModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: TenantIsolationGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
    { provide: APP_GUARD, useClass: AclGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SerializationInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(CorrelationIdMiddleware, AuthenticationMiddleware)
      .forRoutes({ path: '*splat', method: RequestMethod.ALL });
  }
}
