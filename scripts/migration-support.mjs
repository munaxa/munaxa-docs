// What the two migration scripts share: how the Prisma CLI is started, and how its output is kept
// free of credentials (DC-01).
//
// ## The CLI by its own path, never through pnpm
//
// Both scripts used to run `pnpm exec prisma`. That works in a checkout and in nothing else: the
// runtime images carry neither pnpm nor a shell, so the migration image could not have used it.
// Starting `prisma/build/index.js` with the Node that runs this script works in both, and it is the
// same CLI the lockfile pinned — resolved from the repository root, exactly as `pnpm exec` resolves
// it, so there is one Prisma version in play rather than whichever one is on the PATH.
//
// ## The URL never reaches a command line
//
// `prisma db execute --url <url>` put the owner role's password in the child's argument list, where
// `ps` and anything that collects process listings can read it. The URL now travels only in the
// child's environment (`DATABASE_URL`, which `prisma/schema.prisma` names), and every command is
// pointed at the schema instead.
//
// ## Output is redacted before it is written
//
// The Prisma CLI does not print passwords in its own messages, but a driver error can quote a
// connection string, and a log that carries one is a credential leak in whatever collects logs —
// CloudWatch, for the migration task. So the child's output is captured, every PostgreSQL URL and
// every known password is replaced with `***`, and only then written. A migration failure keeps its
// diagnostics; it loses only the secret.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const schemaPath = join(repositoryRoot, 'prisma', 'schema.prisma');

/** Exit codes, so a caller (an ECS task, a pipeline) can tell a configuration error from a failure. */
export const EXIT = Object.freeze({
  /** Every step for every tenant succeeded and the final status check agrees. */
  OK: 0,
  /** A migration, a SQL file or the final verification failed. The database needs attention. */
  MIGRATION_FAILED: 1,
  /** Nothing was touched: the configuration is missing or invalid. */
  CONFIGURATION: 2,
});

const URL_PATTERN = /postgres(?:ql)?:\/\/[^\s'"`<>]+/gi;

/**
 * Replaces every PostgreSQL URL, and every password taken from `urls`, with `***`.
 *
 * The password is matched both as written and percent-decoded, because a URL carries it encoded and
 * an error message may quote it either way.
 */
export function redact(text, urls = []) {
  let out = String(text).replace(URL_PATTERN, 'postgresql://***');
  for (const secret of secretsIn(urls)) {
    out = out.split(secret).join('***');
  }
  return out;
}

function secretsIn(urls) {
  const secrets = new Set();
  for (const url of urls) {
    if (!url) {
      continue;
    }
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        secrets.add(parsed.password);
        secrets.add(decodeURIComponent(parsed.password));
      }
    } catch {
      // Not a URL at all; the pattern above has already replaced anything URL-shaped.
    }
  }
  // Very short values would redact ordinary words; a real password is never this short.
  return [...secrets].filter((secret) => secret.length >= 4);
}

let cli;

/** The Prisma CLI's entry point, resolved from the repository root as `pnpm exec` would. */
export function prismaCli() {
  cli ??= createRequire(join(repositoryRoot, 'package.json')).resolve('prisma/build/index.js');
  return cli;
}

/**
 * Runs the Prisma CLI against one database and writes its redacted output.
 *
 * Returns the exit status; never throws for a failed command, so the caller decides what a failure
 * means. `url` reaches the child only as `DATABASE_URL` and `DATABASE_MIGRATION_URL`.
 */
export function runPrisma(args, url, { quiet = false, input } = {}) {
  const result = spawnSync(process.execPath, [prismaCli(), ...args, '--schema', schemaPath], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // `input` feeds `db execute --stdin`; without it the child gets no stdin at all.
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    env: {
      ...process.env,
      DATABASE_URL: url,
      DATABASE_MIGRATION_URL: url,
      // No update check and no telemetry: the task has no business calling out, and a read-only
      // root filesystem has nowhere to cache the answer.
      CHECKPOINT_DISABLE: '1',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      PRISMA_HIDE_PREVIEW_FLAG_WARNINGS: '1',
    },
  });

  const urls = [url, process.env.DATABASE_MIGRATION_URL, process.env.DATABASE_URL];
  const stdout = redact(result.stdout ?? '', urls);
  const stderr = redact(result.stderr ?? '', urls);
  if (!quiet || result.status !== 0) {
    if (stdout) process.stdout.write(indent(stdout));
    if (stderr) process.stderr.write(indent(stderr));
  }
  if (result.error) {
    process.stderr.write(`  could not start the Prisma CLI (${result.error.code ?? 'error'})\n`);
    return 1;
  }
  // A child killed by a signal has no status; that is a failure, not a success.
  return result.status ?? 1;
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => (line ? `    ${line}` : line))
    .join('\n')
    .replace(/\s*$/, '\n');
}
