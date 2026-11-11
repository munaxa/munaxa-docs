import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { DuplicateError } from './core/errors/application-errors';
import { TenantDatabase } from './core/prisma/tenant-database';
import { TENANT_REGISTRY, type TenantRegistry } from './core/tenancy/tenant-registry.port';
import { ProvisioningService } from './modules/identity/application/provisioning.service';

/**
 * Exit codes, so the task that runs this (the platform's `docs-provision`) can tell the cases apart.
 *
 * `SCHEMA_NOT_READY` is the DC-01 gate: the tenant's database is reachable but not migrated for this
 * build, so nothing was written. `ALREADY_PROVISIONED` means a re-run found the tenant already
 * provisioned and changed nothing — the safe outcome of retrying a run whose result was lost.
 */
const EXIT = { OK: 0, FAILED: 1, SCHEMA_NOT_READY: 3, ALREADY_PROVISIONED: 4 } as const;

/** A connection string never reaches the task's log, even inside a driver's error message. */
function redact(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/[^\s'"`<>]+/gi, 'postgresql://***');
}

/**
 * `pnpm --filter @edms/api provision` — creates a tenant and its first administrator.
 *
 * An application context rather than a script with its own Prisma client: it runs the real
 * service, the real password hasher, the real validation and the real audit writer. A
 * provisioning path that reimplemented any of those would be a second way to create a user,
 * and the second way is always the one that skips a rule.
 *
 * No HTTP server is started. This is an operator command, run once per tenant, and exposing it
 * as an endpoint would make "create an organisation with a full-permission administrator" a
 * request anybody could send.
 *
 * Credentials come from the environment, never from arguments: a password on a command line is
 * in the shell history, in `ps` output, and in whatever collects both.
 */
async function provision(): Promise<void> {
  const required = ['TENANT_SLUG', 'TENANT_NAME', 'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_NAME'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    process.stderr.write(
      `Set ${missing.join(', ')}.\n\n` +
        'Example:\n' +
        '  TENANT_SLUG=acme TENANT_NAME="Acme Ltd" \\\n' +
        '  ADMIN_EMAIL=ada@acme.test ADMIN_NAME="Ada Lovelace" \\\n' +
        '  ADMIN_PASSWORD=… pnpm --filter @edms/api provision\n',
    );
    process.exitCode = EXIT.FAILED;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  try {
    // DC-01: migrate, then provision. The tenant's database must hold every migration this build
    // carries, none failed, and the post-migration row-level security, before anything is written.
    // A tenant missing from the catalogue falls through to the service, which names that problem.
    const slug = (process.env['TENANT_SLUG'] ?? '').trim().toLowerCase();
    const placement = await app.get<TenantRegistry>(TENANT_REGISTRY).bySlug(slug);
    if (placement) {
      const readiness = await app.get(TenantDatabase).schemaReadiness(placement.id);
      if (!readiness.ready) {
        process.stderr.write(
          `PROVISIONING REFUSED: the database of '${slug}' is not migrated for this build ` +
            `(${String(readiness.applied)} of ${String(readiness.expected)} migrations applied).\n` +
            readiness.problems.map((problem) => `  - ${problem}\n`).join('') +
            'Nothing was written. Run the migration task (docs-migrate) to completion, then re-run.\n',
        );
        process.exitCode = EXIT.SCHEMA_NOT_READY;
        return;
      }
    }

    const result = await app.get(ProvisioningService).provision({
      slug: process.env['TENANT_SLUG'] ?? '',
      name: process.env['TENANT_NAME'] ?? '',
      adminEmail: process.env['ADMIN_EMAIL'] ?? '',
      adminPassword: process.env['ADMIN_PASSWORD'] ?? '',
      adminDisplayName: process.env['ADMIN_NAME'] ?? '',
    });

    // Written to stdout directly rather than through `console`: this is a command whose output
    // *is* its result, not logging, and the lint rule that bans `console.log` is right to.
    // The identifiers, so an operator can find what was made. Never the password.
    process.stdout.write(
      `Provisioned '${process.env['TENANT_SLUG'] ?? ''}'\n` +
        `  tenant  ${result.tenantId}\n` +
        `  role    ${result.roleId}\n` +
        `  admin   ${result.adminUserId}\n`,
    );
  } catch (error) {
    // The service's own refusal to provision twice (`alreadyProvisioned`), not some other duplicate.
    if (error instanceof DuplicateError && error.message === 'That organisation already exists.') {
      process.stderr.write(
        `'${process.env['TENANT_SLUG'] ?? ''}' is already provisioned; nothing was changed.\n`,
      );
      process.exitCode = EXIT.ALREADY_PROVISIONED;
      return;
    }
    process.stderr.write(
      `${redact(error instanceof Error ? error.message : 'Provisioning failed.')}\n`,
    );
    process.exitCode = EXIT.FAILED;
  } finally {
    await app.close();
  }
}

void provision();
