import { type MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { RateLimitGuard } from './core/security/rate-limit.guard';

import { AuditModule } from './core/audit';
import {
  API_KEY_AUTHENTICATOR,
  AuthModule,
  AuthenticationGuard,
  AuthenticationMiddleware,
} from './core/auth';
import { AuthorizationModule, AclGuard, RbacGuard } from './core/authorization';
import { ConfigModule } from './core/config';
import { AllExceptionsFilter } from './core/errors';
import {
  CorrelationIdMiddleware,
  IdempotencyInterceptor,
  SerializationInterceptor,
} from './core/http';
import { MessagingModule } from './core/messaging';
import {
  LoggerModule,
  ObservabilityModule,
  RequestObservabilityInterceptor,
} from './core/observability';
import { OutboxModule } from './core/outbox';
import { BulkModule } from './core/bulk';
import { PersistenceModule } from './core/persistence';
import { PrismaModule } from './core/prisma';
import { TenancyModule, TenantIsolationGuard } from './core/tenancy';
import { InfrastructureModule } from './infrastructure/infrastructure.module';
import { AdministrationModule } from './modules/administration/administration.module';
import { AuditModule as AuditDomainModule } from './modules/audit/audit.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DocumentModule } from './modules/document/document.module';
import { IdentityModule } from './modules/identity/identity.module';
import { IdentityApiKeyAuthenticator } from './modules/identity/infrastructure/api-key.authenticator';
import { IntegrationModule } from './modules/integration/integration.module';
import { JwtTokenService } from './modules/identity/infrastructure/jwt.token-service';
import { LibraryModule } from './modules/library/library.module';
import { NotificationModule } from './modules/notification/notification.module';
import { OrganizationModule } from './modules/organization/organization.module';
import { PreviewModule } from './modules/preview/preview.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { DispositionModule } from './modules/retention/disposition.module';
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
    PersistenceModule,
    TenancyModule,
    // Identity ships a real verifier, so the port no longer resolves to the one that rejects
    // everything. This is the only place that may import both `core/` and a module.
    AuthModule.withVerifier(JwtTokenService),
    AuthorizationModule,
    AuditModule,
    // Phase 16. Global, and after Auth and Authorization because it resolves the caller's reach
    // per object through `ACL_RESOLVER` — the same decision `AclGuard` makes on a single-object
    // route, made N times because a bulk route has N objects and `@ScopedTo` binds one.
    BulkModule,
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
    DispositionModule,
    ReportingModule,
    DashboardModule,
    // Phase 17. After Audit, whose `AUDIT_STREAM_SOURCE` it consumes.
    IntegrationModule,
  ],
  providers: [
    /**
     * The machine-credential resolver, and the middleware that consumes it — Phase 17.
     *
     * Both are provided **here** rather than inside `AuthModule`, and the reason is a real
     * constraint rather than a preference. `IdentityApiKeyAuthenticator` needs Identity's
     * credential repository and settings reader, so a class registered inside `AuthModule` cannot
     * resolve it — that module's scope has neither. And Nest resolves a middleware from the module
     * that *declares* it, so binding the token here while leaving the middleware in `AuthModule`
     * would produce an instance that could not see the binding.
     *
     * The composition root is the one place that may import both `core/` and a module, which is
     * exactly what this needs and exactly what `TOKEN_VERIFIER` has used since Phase 1. The
     * `AuthModule` instance of the middleware still exists and is simply not the one applied.
     */
    { provide: API_KEY_AUTHENTICATOR, useExisting: IdentityApiKeyAuthenticator },
    AuthenticationMiddleware,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // First, deliberately: an anonymous flood is refused before anything expensive happens. The
    // identity dimensions still work, because the authentication *middleware* has already run by
    // the time any guard does.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: TenantIsolationGuard },
    { provide: APP_GUARD, useClass: RbacGuard },
    { provide: APP_GUARD, useClass: AclGuard },
    // First of the interceptors, so the duration it measures covers everything the others do —
    // an observability layer that measured only what it wrapped last would report the fast half
    // of every request. Phase 18.
    { provide: APP_INTERCEPTOR, useClass: RequestObservabilityInterceptor },
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
