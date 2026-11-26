import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { type TenantId, SystemRole, asId } from '@edms/domain';

import { AppModule } from './app.module';
import { TenantDatabase } from './core/prisma/tenant-database';
import { UNIT_OF_WORK, type UnitOfWork } from './core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from './core/tenancy/tenant-context';
import { TENANT_REGISTRY, type TenantRegistry } from './core/tenancy/tenant-registry.port';
import { checkDemoSeedEnvironment } from './demo/seed-guard';
import { StarterSeeder } from './demo/starter-seeder';
import { APPROVAL_ROUTING_SERVICE } from './modules/administration/application/approval-routing.ports';
import type { ApprovalRoutingService } from './modules/administration/application/approval-routing.service';
import {
  CONFIGURATION_SERVICE,
  NUMBERING_ADMIN_SERVICE,
} from './modules/administration/application/administration.ports';
import type { ConfigurationService } from './modules/administration/application/configuration.service';
import type { NumberingAdminService } from './modules/administration/application/numbering-admin.service';
import {
  ROLE_ADMIN_SERVICE,
  USER_ADMIN_SERVICE,
} from './modules/identity/application/administration.ports';
import type { RoleAdminService } from './modules/identity/application/role-admin.service';
import type { UserAdminService } from './modules/identity/application/user-admin.service';
import { LIBRARY_ADMIN_SERVICE } from './modules/library/application/administration.ports';
import type { LibraryAdminService } from './modules/library/application/library-admin.service';
import { SCOPE_ADMIN_SERVICE } from './modules/organization/application/ports';
import type { ScopeAdminService } from './modules/organization/application/scope-admin.service';
import { WORKFLOW_ADMIN_SERVICE } from './modules/workflow/application/administration.ports';
import { WORKFLOW_DIRECTORY, type WorkflowDirectory } from './modules/workflow/application/ports';
import type { WorkflowAdminService } from './modules/workflow/application/workflow-admin.service';

/**
 * Exit codes, distinct so whoever runs this can tell the cases apart without reading the log.
 * `REFUSED` means the environment did not permit it and nothing was opened, let alone written.
 */
const EXIT = { OK: 0, FAILED: 1, REFUSED: 2, SCHEMA_NOT_READY: 3, NOT_PROVISIONED: 5 } as const;

/** A connection string never reaches the log, even inside a driver's error message. */
function redact(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s'"`<>]+/gi, 'postgresql://***');
}

/**
 * `pnpm --filter @edms/api seed:demo` — loads the demo starter configuration into one tenant.
 *
 * Opt-in, for Testing and development only: see `demo/seed-guard.ts` for the two environment
 * variables it refuses to run without, and `docs/operations/demo-starter-configuration.md` for
 * what it creates. It is additive and re-runnable: anything that already exists, by code or key,
 * is left untouched.
 *
 * Like `provision.ts`, an application context rather than a script with its own Prisma client, so
 * every item goes through the real validation, the real services and the real audit writer. No
 * HTTP server is started.
 */
async function seedDemo(): Promise<void> {
  const permission = checkDemoSeedEnvironment(process.env);
  if (!permission.allowed) {
    process.stderr.write(
      'DEMO SEED REFUSED: nothing was opened or written.\n' +
        permission.problems.map((problem) => `  - ${problem}\n`).join('') +
        '\nExample:\n' +
        '  DEMO_SEED_TENANT=acme DEMO_SEED_CONFIRM_TENANT=acme DEMO_SEED_ENVIRONMENT=nonprod \\\n' +
        '  [DEMO_SEED_DRY_RUN=true] pnpm --filter @edms/api seed:demo\n',
    );
    process.exitCode = EXIT.REFUSED;
    return;
  }
  const { slug, dryRun } = permission;

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  try {
    const placement = await app.get<TenantRegistry>(TENANT_REGISTRY).bySlug(slug);
    if (!placement) {
      process.stderr.write(`'${slug}' is not in this deployment's tenant catalogue.\n`);
      process.exitCode = EXIT.NOT_PROVISIONED;
      return;
    }
    const readiness = await app.get(TenantDatabase).schemaReadiness(placement.id);
    if (!readiness.ready) {
      process.stderr.write(
        `DEMO SEED REFUSED: the database of '${slug}' is not migrated for this build ` +
          `(${String(readiness.applied)} of ${String(readiness.expected)} migrations applied).\n`,
      );
      process.exitCode = EXIT.SCHEMA_NOT_READY;
      return;
    }

    const tenantId = asId<TenantId>(placement.id);
    const context: RequestContext = {
      tenantId,
      // No person is acting: the trail records the system, on the SYSTEM channel, under a
      // correlation id that names this command — which is the truth about who made these rows.
      userId: null,
      roles: [],
      permissions: [],
      sessionId: null,
      correlationId: `seed-demo:${slug}`,
      permissionVersion: 0,
      locale: 'en',
      channel: 'SYSTEM',
    };

    const unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    const directory = app.get<WorkflowDirectory>(WORKFLOW_DIRECTORY);

    const result = await runWithContext(context, async () => {
      // A tenant that was never provisioned has no administrator and no organisation tree, and
      // demo configuration on top of that is a workspace nobody can enter.
      const administrators = await unitOfWork.run(() =>
        directory.holdersOfRole(SystemRole.TENANT_ADMIN, { kind: 'TENANT', nodeId: null }),
      );
      if (administrators.length === 0) {
        return null;
      }

      const seeder = new StarterSeeder(
        {
          scopes: app.get<ScopeAdminService>(SCOPE_ADMIN_SERVICE),
          config: app.get<ConfigurationService>(CONFIGURATION_SERVICE),
          numbering: app.get<NumberingAdminService>(NUMBERING_ADMIN_SERVICE),
          routing: app.get<ApprovalRoutingService>(APPROVAL_ROUTING_SERVICE),
          workflows: app.get<WorkflowAdminService>(WORKFLOW_ADMIN_SERVICE),
          libraries: app.get<LibraryAdminService>(LIBRARY_ADMIN_SERVICE),
          roles: app.get<RoleAdminService>(ROLE_ADMIN_SERVICE),
          users: app.get<UserAdminService>(USER_ADMIN_SERVICE),
          administrators: () => Promise.resolve(administrators.map(String)),
        },
        { dryRun },
      );
      return seeder.run();
    });

    if (result === null) {
      process.stderr.write(
        `'${slug}' has no administrator, so it is not provisioned. Run provisioning first.\n`,
      );
      process.exitCode = EXIT.NOT_PROVISIONED;
      return;
    }

    // Written to stdout directly: this command's output *is* its result.
    process.stdout.write(
      `${dryRun ? 'DRY RUN (nothing written) for' : 'Demo starter configuration for'} '${slug}'\n` +
        result.steps
          .map(
            (step) =>
              `  ${step.outcome.padEnd(7)} ${step.kind.padEnd(22)} ${step.code}` +
              (step.note === undefined ? '' : `  (${step.note})`) +
              '\n',
          )
          .join('') +
        `created ${String(result.created)}, already present ${String(result.existing)}, ` +
        `skipped ${String(result.skipped)}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${redact(error instanceof Error ? error.message : 'Demo seed failed.')}\n` +
        'Items created before the failure are kept; a re-run continues from them.\n',
    );
    process.exitCode = EXIT.FAILED;
  } finally {
    await app.close();
  }
}

void seedDemo();
