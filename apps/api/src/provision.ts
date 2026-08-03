import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ProvisioningService } from './modules/identity/application/provisioning.service';

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
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  try {
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
    process.stderr.write(`${error instanceof Error ? error.message : 'Provisioning failed.'}\n`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

void provision();
