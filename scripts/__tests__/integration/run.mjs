// Runs the repository's migration scripts as a deployment does, collecting their output.

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { repositoryRoot } from '../../migration-support.mjs';

/**
 * Starts `scripts/<script>` with `env` (on top of PATH only, as the migration task has nothing
 * else). Returns the child and a promise of `{ status, stdout, stderr }`.
 */
export function start(script, env) {
  const child = spawn(process.execPath, [join(repositoryRoot, 'scripts', script)], {
    cwd: repositoryRoot,
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const result = new Promise((done) =>
    child.on('close', (status) => done({ status, stdout, stderr, output: stdout + stderr })),
  );
  return { child, result, output: () => stdout + stderr };
}

export function run(script, env) {
  return start(script, env).result;
}

export const migrate = (url, env = {}) =>
  run('migrate-tenants.mjs', { DATABASE_MIGRATION_URL: url, TENANT_SLUG: 'acme', ...env });

export async function until(condition, timeoutMs = 60_000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resume) => setTimeout(resume, 50));
  }
}
