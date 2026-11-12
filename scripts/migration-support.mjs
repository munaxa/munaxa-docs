// What the two migration scripts share: how the Prisma CLI is started, how its output is kept free
// of credentials, and the lock that keeps two migration runs off one database (DC-01, L-1, L-6).
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
// ## Output is streamed, and redacted before it is written (L-6)
//
// The Prisma CLI does not print passwords in its own messages, but a driver error can quote a
// connection string, and a log that carries one is a credential leak in whatever collects logs —
// CloudWatch, for the migration task. So every PostgreSQL URL and every known password is replaced
// with `***` before a byte is written. Output used to be buffered until each command exited, so a
// long or stuck `migrate deploy` logged nothing while it ran; it is now written line by line as the
// child produces it (`createRedactingWriter`). Memory stays bounded whatever the child prints: a
// line longer than the buffer is written in pieces, cut only where no secret or URL can straddle the
// cut, and a single run of more than that many characters without any whitespace (which is the only
// shape a URL can take) is withheld rather than cut.
//
// ## One migration run per database at a time (L-1)
//
// Prisma's own advisory lock serialises `migrate deploy` and nothing else. The per-database SQL
// before it and the post-migration SQL after it were serialised only by the instruction "run one
// copy at a time", and two overlapping runs of different releases could leave the older release's
// post-migration file in effect unnoticed. `acquireMigrationLock` takes a PostgreSQL session-level
// advisory lock on the tenant database, on its own connection, before the runner touches or reads
// anything, and holds it until the last step has finished. See `MIGRATION_LOCK` for its identity
// and docs/operations/deployment.md §2a for how it behaves.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const schemaPath = join(repositoryRoot, 'prisma', 'schema.prisma');

/** Exit codes, so a caller (an ECS task, a pipeline) can tell a configuration error from a failure. */
export const EXIT = Object.freeze({
  /** Every step for every tenant succeeded and the final status check agrees. */
  OK: 0,
  /**
   * A migration, a SQL file or the final verification failed, the database could not be reached,
   * the run was cancelled, or it lost its lock. The database needs attention.
   */
  MIGRATION_FAILED: 1,
  /** Nothing was touched: the configuration is missing or invalid. */
  CONFIGURATION: 2,
  /**
   * Another migration run held the tenant database's migration lock for longer than the wait
   * allowed. Nothing was read or changed on that database (earlier tenants in a catalogue may have
   * been migrated). Re-run once the other run has finished.
   */
  LOCKED: 3,
});

// --- Redaction -----------------------------------------------------------------------------------

const URL_PATTERN = /postgres(?:ql)?:\/\/[^\s'"`<>]+/gi;

/**
 * Replaces every PostgreSQL URL, and every password taken from `urls`, with `***`.
 *
 * The password is matched both as written and percent-decoded, because a URL carries it encoded and
 * an error message may quote it either way.
 */
export function redact(text, urls = []) {
  return redactUrls(replaceSecrets(String(text), secretsIn(urls)));
}

function redactUrls(text) {
  return text.replace(URL_PATTERN, 'postgresql://***');
}

function replaceSecrets(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    out = out.split(secret).join('***');
  }
  return out;
}

export function secretsIn(urls) {
  const secrets = new Set();
  for (const url of urls) {
    if (!url) {
      continue;
    }
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        secrets.add(parsed.password);
        try {
          secrets.add(decodeURIComponent(parsed.password));
        } catch {
          // A malformed escape: the encoded form above is what any output would quote.
        }
      }
    } catch {
      // Not a URL at all; the pattern above replaces anything URL-shaped.
    }
  }
  // Very short values would redact ordinary words; a real password is never this short. Longest
  // first, so a password that contains another one is replaced whole.
  return [...secrets].filter((secret) => secret.length >= 4).sort((a, b) => b.length - a.length);
}

/** How much of an unterminated line is held before part of it is written. */
const MAX_PENDING = 64 * 1024;
const WHITESPACE = /\s/;

/**
 * A line-oriented, redacting writer for one output stream of a child process.
 *
 * `push(text)` accepts decoded text in chunks of any size, split anywhere; `end()` flushes what is
 * left. Each complete line is redacted and written as soon as it arrives, prefixed with `prefix`
 * (empty lines get no prefix). What is held between calls is never more than about `MAX_PENDING`
 * characters, plus the longest secret.
 *
 * The invariant that keeps redaction exact across chunk boundaries: text is written only up to a
 * point where nothing that must be redacted can straddle it.
 *
 * - Every complete occurrence of a secret in the held text is replaced before anything is cut, and a
 *   cut inside an unterminated line is made at least one secret-length before its end, so a secret
 *   whose first characters have arrived and whose last have not is always still held. A cut at a
 *   line break needs no margin, unless a secret itself contains a line break.
 * - URLs are matched only in text that is being written, and a cut is only ever made at whitespace,
 *   which no URL contains, so a URL is never written in two pieces.
 * - A single whitespace-free run longer than the buffer (it could be the middle of a URL whose
 *   scheme is no longer held) is withheld up to the next whitespace, and a one-line note says so.
 */
export function createRedactingWriter(write, urls = [], { prefix = '' } = {}) {
  const secrets = secretsIn(urls);
  const margin = Math.max(0, ...secrets.map((secret) => secret.length));
  const lineCutIsSafe = !secrets.some((secret) => /[\r\n]/.test(secret));
  const limit = Math.max(MAX_PENDING, 2 * margin);
  let pending = '';
  let withholding = false;
  let atLineStart = true;

  const emit = (text) => {
    if (!text) {
      return;
    }
    let out = '';
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      if (line) {
        if (atLineStart) {
          out += prefix;
        }
        out += line;
        atLineStart = false;
      }
      if (index < lines.length - 1) {
        out += '\n';
        atLineStart = true;
      }
    }
    if (out) {
      write(out);
    }
  };

  const withhold = () => {
    if (!withholding) {
      withholding = true;
      emit(
        `${atLineStart ? '' : '\n'}[output withheld: more than ${limit} characters without whitespace]\n`,
      );
    }
  };

  // Drops a withheld run up to the first whitespace in `text`; returns what follows it.
  const skipWithheld = (text) => {
    const index = text.search(WHITESPACE);
    if (index < 0) {
      return '';
    }
    withholding = false;
    return text.slice(index);
  };

  const flush = () => {
    pending = replaceSecrets(pending, secrets);

    // Complete lines first.
    const lineEnd = pending.lastIndexOf('\n');
    if (lineEnd >= 0 && (lineCutIsSafe || lineEnd + 1 <= pending.length - margin)) {
      emit(redactUrls(pending.slice(0, lineEnd + 1)));
      pending = pending.slice(lineEnd + 1);
    }
    if (pending.length <= limit) {
      return;
    }

    // An unterminated line longer than the buffer: write up to the last whitespace that leaves a
    // full secret-length held.
    const searchable = pending.slice(0, Math.max(0, pending.length - margin));
    let cut = -1;
    for (let index = searchable.length - 1; index >= 0; index -= 1) {
      if (WHITESPACE.test(searchable[index])) {
        cut = index;
        break;
      }
    }
    if (cut >= 0) {
      emit(redactUrls(pending.slice(0, cut + 1)));
      pending = pending.slice(cut + 1);
      return;
    }

    // No whitespace at all: withhold the run up to its end.
    withhold();
    pending = skipWithheld(pending);
  };

  return {
    push(chunk) {
      let text = String(chunk);
      if (withholding) {
        text = skipWithheld(text);
      }
      if (!text) {
        return;
      }
      pending += text;
      if (pending.includes('\n') || pending.length > limit) {
        flush();
      }
    },
    end() {
      if (!withholding && pending) {
        emit(redact(pending, urls));
      }
      pending = '';
      if (!atLineStart) {
        write('\n');
        atLineStart = true;
      }
    },
  };
}

// --- Child processes -----------------------------------------------------------------------------

/** Children that are running now, so a cancelled run can stop them before it lets go of its lock. */
const running = new Set();

/**
 * Runs `command` with `args`, streaming its stdout and stderr through redacting writers as it runs.
 *
 * Resolves to the exit status: the child's own, or 1 when it could not be started or was ended by a
 * signal (a child killed by a signal has no status, and that is a failure, not a success). Never
 * rejects, so the caller decides what a failure means. Secrets reach the child only through `env`.
 */
export function runStreaming(
  command,
  args,
  {
    cwd = repositoryRoot,
    env = process.env,
    input,
    urls = [],
    prefix = '    ',
    processGroup = true,
    stdout = (text) => process.stdout.write(text),
    stderr = (text) => process.stderr.write(text),
  } = {},
) {
  return new Promise((done) => {
    let settled = false;
    const finish = (status) => {
      if (!settled) {
        settled = true;
        done(status);
      }
    };

    const out = createRedactingWriter(stdout, urls, { prefix });
    const err = createRedactingWriter(stderr, urls, { prefix });

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        // Its own process group, so stopping it stops what it started too (the Prisma CLI runs the
        // schema engine as a child of its own).
        detached: processGroup,
        // `input` feeds `db execute --stdin`; without it the child gets no stdin at all.
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr(`  could not start the child process (${error.code ?? 'error'})\n`);
      finish(1);
      return;
    }
    running.add({ child, processGroup });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));

    if (input !== undefined) {
      // A child that exits before reading all of its input is reported by its exit status.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    let startError;
    child.on('error', (error) => {
      startError ??= error;
      if (child.pid === undefined) {
        forget(child);
        stderr(`  could not start the child process (${error.code ?? 'error'})\n`);
        finish(1);
      }
    });
    child.on('close', (code) => {
      forget(child);
      out.end();
      err.end();
      if (startError && child.pid === undefined) {
        finish(1);
        return;
      }
      finish(code ?? 1);
    });
  });
}

function forget(child) {
  for (const entry of running) {
    if (entry.child === child) {
      running.delete(entry);
    }
  }
}

function signalChild({ child, processGroup }, signal) {
  try {
    if (processGroup && child.pid !== undefined) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Already gone.
  }
}

/**
 * Stops every running child and what it started: SIGTERM to its process group, then SIGKILL to the
 * group if it is still running after `graceMs`. Resolves once every child has exited, so a lock is
 * never released while a child could still be writing.
 */
export function stopRunningChildren(graceMs = 10_000) {
  const entries = [...running];
  return Promise.all(
    entries.map(
      (entry) =>
        new Promise((done) => {
          const { child } = entry;
          if (child.exitCode !== null || child.signalCode !== null) {
            done();
            return;
          }
          const timer = setTimeout(() => signalChild(entry, 'SIGKILL'), graceMs);
          child.once('close', () => {
            clearTimeout(timer);
            done();
          });
          signalChild(entry, 'SIGTERM');
        }),
    ),
  );
}

let cli;

/** The Prisma CLI's entry point, resolved from the repository root as `pnpm exec` would. */
export function prismaCli() {
  cli ??= createRequire(join(repositoryRoot, 'package.json')).resolve('prisma/build/index.js');
  return cli;
}

/**
 * The environment a Prisma child gets: this process's, with the one database URL it works on and
 * without the tenant catalogue (which carries every tenant's credentials and is not the child's
 * business).
 */
export function childEnvironment(url, extra = {}) {
  const env = { ...process.env };
  delete env.TENANT_CATALOGUE;
  delete env.TENANT_CATALOGUE_PATH;
  return {
    ...env,
    DATABASE_URL: url,
    DATABASE_MIGRATION_URL: url,
    // No update check and no telemetry: the task has no business calling out, and a read-only
    // root filesystem has nowhere to cache the answer.
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    PRISMA_HIDE_PREVIEW_FLAG_WARNINGS: '1',
    ...extra,
  };
}

/**
 * Runs the Prisma CLI against one database, streaming its redacted output as it runs.
 *
 * Resolves to the exit status; never rejects for a failed command, so the caller decides what a
 * failure means. `url` reaches the child only as `DATABASE_URL` and `DATABASE_MIGRATION_URL`.
 */
export function runPrisma(args, url, { input, stdout, stderr, processGroup } = {}) {
  return runStreaming(process.execPath, [prismaCli(), ...args, '--schema', schemaPath], {
    env: childEnvironment(url),
    input,
    ...(processGroup === undefined ? {} : { processGroup }),
    urls: [url, process.env.DATABASE_MIGRATION_URL, process.env.DATABASE_URL],
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  });
}

// --- The migration lock (L-1) --------------------------------------------------------------------

/**
 * The lock's identity: a PostgreSQL advisory lock in the two-key form, `(classid, objid)` =
 * `(1297436248, 1145915719)`, the ASCII of 'MUNX' and 'DMIG'. Advisory locks are per database, so
 * this is one lock per tenant database. The two-key form lives in a different key space
 * (`pg_locks.objsubid = 2`) from the single-bigint lock Prisma takes for `migrate deploy`
 * (`objsubid = 1`), so the two never contend; the runner holds this one around Prisma's.
 *
 * Seen by an operator in `pg_locks` as `locktype = 'advisory' AND classid = 1297436248 AND objid =
 * 1145915719 AND objsubid = 2`, held by the backend whose `application_name` is
 * `munaxa-docs-migrate-lock`.
 */
export const MIGRATION_LOCK = Object.freeze({
  classid: 1297436248,
  objid: 1145915719,
  applicationName: 'munaxa-docs-migrate-lock',
});

/** How long a run waits for the lock by default, and the most it may be told to wait. */
export const LOCK_WAIT_DEFAULT_SECONDS = 120;
export const LOCK_WAIT_MAX_SECONDS = 3600;

const LOCK_HELD_SQL = `
SELECT pg_backend_pid() AS pid,
       EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = ${MIGRATION_LOCK.classid} AND objid = ${MIGRATION_LOCK.objid}
            AND objsubid = 2 AND granted AND pid = pg_backend_pid()
       ) AS held`;

const LOCK_HOLDER_SQL = `
SELECT l.pid AS pid, a.application_name AS application, a.backend_start AS since
  FROM pg_locks l
  LEFT JOIN pg_stat_activity a ON a.pid = l.pid
 WHERE l.locktype = 'advisory'
   AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
   AND l.classid = ${MIGRATION_LOCK.classid} AND l.objid = ${MIGRATION_LOCK.objid}
   AND l.objsubid = 2 AND l.granted
 LIMIT 1`;

/**
 * The SQL a migration step runs first to prove, inside the database and in the same transaction as
 * its own work, that the run it belongs to still holds the lock. `pid` is the backend of the lock's
 * connection.
 */
export function assertLockHeldSql(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('the migration lock backend id is not a positive integer');
  }
  return `
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_locks
     WHERE locktype = 'advisory'
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = ${MIGRATION_LOCK.classid} AND objid = ${MIGRATION_LOCK.objid}
       AND objsubid = 2 AND granted AND pid = ${pid}
  ) THEN
    RAISE EXCEPTION 'the Docs migration lock is not held by this migration run (backend %); nothing was changed', ${pid};
  END IF;
END
$$;
`;
}

/** The lock was held by another run for longer than the wait allowed. Nothing was touched. */
export class MigrationLockTimeout extends Error {
  constructor(waitedSeconds, holder) {
    super(
      `another migration run holds the migration lock` +
        (holder ? ` (backend ${holder.pid}, ${holder.application || 'no application name'})` : '') +
        `; waited ${waitedSeconds}s`,
    );
    this.name = 'MigrationLockTimeout';
    this.holder = holder;
  }
}

/** The lock's connection was lost or the lock is no longer held: the run must stop. */
export class MigrationLockLost extends Error {
  constructor(reason) {
    super(`the migration lock was lost (${reason})`);
    this.name = 'MigrationLockLost';
  }
}

/**
 * The wait for the lock, from `MIGRATION_LOCK_TIMEOUT_SECONDS`: whole seconds, 0 to
 * `LOCK_WAIT_MAX_SECONDS`, `LOCK_WAIT_DEFAULT_SECONDS` when unset. Anything else is a configuration
 * error (returned as `null`), refused before any database is touched.
 */
export function lockWaitSeconds(value = process.env.MIGRATION_LOCK_TIMEOUT_SECONDS) {
  if (value === undefined || value === '') {
    return LOCK_WAIT_DEFAULT_SECONDS;
  }
  if (!/^\d+$/.test(String(value))) {
    return null;
  }
  const seconds = Number(value);
  return seconds <= LOCK_WAIT_MAX_SECONDS ? seconds : null;
}

/** The URL of the lock's own connection: one connection, named, with a bounded connect. */
export function lockConnectionUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '1');
  parsed.searchParams.set('pool_timeout', '30');
  if (!parsed.searchParams.has('connect_timeout')) {
    parsed.searchParams.set('connect_timeout', '10');
  }
  parsed.searchParams.set('application_name', MIGRATION_LOCK.applicationName);
  return parsed.toString();
}

/**
 * Takes the migration lock on the database `url` names, waiting at most `waitSeconds`.
 *
 * The lock is a session-level advisory lock held by one dedicated connection (a pool of exactly
 * one), so acquiring, checking and releasing it all happen on the same PostgreSQL session. It is
 * released by `release()`, and by PostgreSQL itself whenever that session ends: on success, on
 * failure, when this process is cancelled or killed, or when the connection drops. A heartbeat
 * checks every `heartbeatMs` that the same session still holds it; if it does not, `onLost` is
 * called and every later `assertHeld()` throws, so a run never continues believing it is alone.
 *
 * Rejects with `MigrationLockTimeout` when another session holds the lock for the whole wait, with
 * the connection's own error when the database cannot be reached, and with an error when `signal`
 * is aborted while waiting. It never resolves without the lock.
 */
export async function acquireMigrationLock(
  url,
  {
    waitSeconds = LOCK_WAIT_DEFAULT_SECONDS,
    pollMs = 500,
    heartbeatMs = 5_000,
    onWait,
    onLost,
    signal,
  } = {},
) {
  const { PrismaClient } = await importPrismaClient();
  const client = new PrismaClient({ datasourceUrl: lockConnectionUrl(url) });

  const state = async () => {
    const [row] = await client.$queryRawUnsafe(LOCK_HELD_SQL);
    return { pid: Number(row.pid), held: row.held === true };
  };

  let pid;
  try {
    await client.$connect();
    ({ pid } = await state());

    const deadline = Date.now() + waitSeconds * 1000;
    let waited = false;
    for (;;) {
      const [row] = await client.$queryRawUnsafe(
        `SELECT pg_try_advisory_lock(${MIGRATION_LOCK.classid}, ${MIGRATION_LOCK.objid}) AS locked`,
      );
      const now = await state();
      if (now.pid !== pid) {
        // The pool replaced the connection between two queries: whatever was locked is gone.
        throw new MigrationLockLost('its connection was replaced while acquiring');
      }
      if (row.locked === true && now.held) {
        break;
      }
      if (Date.now() >= deadline) {
        const [holder] = await client.$queryRawUnsafe(LOCK_HOLDER_SQL).catch(() => []);
        throw new MigrationLockTimeout(
          waitSeconds,
          holder ? { pid: Number(holder.pid), application: holder.application ?? '' } : undefined,
        );
      }
      if (signal?.aborted) {
        throw new Error('cancelled while waiting for the migration lock');
      }
      if (!waited) {
        waited = true;
        onWait?.();
      }
      await new Promise((resume) => setTimeout(resume, pollMs));
    }
  } catch (error) {
    await client.$disconnect().catch(() => {});
    throw error;
  }

  let lost;
  let checking = false;
  const markLost = (reason) => {
    if (!lost) {
      lost = new MigrationLockLost(reason);
      onLost?.(lost);
    }
  };
  const heartbeat = setInterval(() => {
    if (checking || lost) {
      return;
    }
    checking = true;
    state()
      .then((now) => {
        if (now.pid !== pid) markLost('its connection was replaced');
        else if (!now.held) markLost('the database no longer reports it held');
      })
      .catch(() => markLost('its connection failed'))
      .finally(() => {
        checking = false;
      });
  }, heartbeatMs);
  heartbeat.unref();

  let released = false;
  return {
    /** The backend id of the lock's session, for `assertLockHeldSql`. */
    pid,
    /** Throws `MigrationLockLost` unless the same session still holds the lock right now. */
    async assertHeld() {
      if (lost) {
        throw lost;
      }
      let now;
      try {
        now = await state();
      } catch {
        markLost('its connection failed');
        throw lost;
      }
      if (now.pid !== pid || !now.held) {
        markLost(
          now.pid !== pid
            ? 'its connection was replaced'
            : 'the database no longer reports it held',
        );
        throw lost;
      }
    },
    get lost() {
      return lost;
    },
    /** Unlocks and closes the session. Safe to call more than once; never throws. */
    async release() {
      if (released) {
        return;
      }
      released = true;
      clearInterval(heartbeat);
      try {
        if (!lost) {
          await client.$queryRawUnsafe(
            `SELECT pg_advisory_unlock(${MIGRATION_LOCK.classid}, ${MIGRATION_LOCK.objid}) AS unlocked`,
          );
        }
      } catch {
        // Closing the session below releases a session-level lock in any case.
      }
      await client.$disconnect().catch(() => {});
    },
  };
}

/** A one-line, non-secret description of why the lock could not be taken. */
export function describeConnectionError(error, urls = []) {
  const code = error?.errorCode ?? error?.code;
  const first =
    String(error?.message ?? error)
      .split('\n')
      .find((line) => line.trim()) ?? 'error';
  return redact(`${code ? `${code}: ` : ''}${first.trim().replace(/[.\s]+$/, '')}`, urls);
}

let prismaClientModule;

/**
 * Whether `@prisma/client` has a generated client next to it. A fresh checkout after `pnpm install`
 * has none (the migration image always has one: its build runs `prisma generate`), and importing
 * the package without one fails with "Cannot find module '.prisma/client/default'".
 */
function generatedClientPresent(clientEntry) {
  try {
    const generated = createRequire(clientEntry).resolve('.prisma/client/default');
    return existsSync(join(dirname(generated), 'schema.prisma'));
  } catch {
    return false;
  }
}

/**
 * Generates the Prisma client from this repository's schema when it is missing, the same as `pnpm
 * prisma:generate`. It reads only the schema and writes only into `node_modules`; it connects to no
 * database. Throws when generation fails, which the caller reports as a connection-stage failure
 * before any database is touched.
 */
async function ensureGeneratedClient(clientEntry) {
  if (generatedClientPresent(clientEntry)) return;
  process.stdout.write('    generating the Prisma client (none in this checkout yet)\n');
  const env = { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' };
  delete env.TENANT_CATALOGUE;
  delete env.TENANT_CATALOGUE_PATH;
  const status = await runStreaming(
    process.execPath,
    [prismaCli(), 'generate', '--schema', schemaPath],
    { env, urls: [process.env.DATABASE_MIGRATION_URL, process.env.DATABASE_URL] },
  );
  if (status !== 0 || !generatedClientPresent(clientEntry)) {
    throw Object.assign(new Error(`prisma generate exited with status ${status}`), {
      code: 'PRISMA_GENERATE_FAILED',
    });
  }
}

function importPrismaClient() {
  // Resolved from the repository root, like the CLI, so the generated client the lockfile pinned is
  // the one in use — in a checkout and in the migration image alike.
  prismaClientModule ??= (async () => {
    const entry = createRequire(join(repositoryRoot, 'package.json')).resolve('@prisma/client');
    await ensureGeneratedClient(entry);
    return import(pathToFileURL(entry).href);
  })();
  // A failed attempt is not cached, so a later call can try again.
  prismaClientModule.catch(() => {
    prismaClientModule = undefined;
  });
  return prismaClientModule;
}
