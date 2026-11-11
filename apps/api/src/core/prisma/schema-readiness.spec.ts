import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type BuildSchema,
  HISTORY_READABLE_SQL,
  MIGRATION_ROWS_SQL,
  type MigrationRow,
  EVER_APPLIED_SQL,
  LATEST_RUN_SQL,
  POST_MIGRATE_READABLE_SQL,
  type RawQuerier,
  SchemaNotReadyError,
  UNPROTECTED_TABLES_SQL,
  checkSchemaReadiness,
  evaluateSchema,
  expectedMigrations,
  expectedPostMigrate,
  locateMigrations,
  locatePostMigrate,
} from './schema-readiness';

/**
 * DC-01: the gate provisioning and API start-up run before touching a tenant database. The decision
 * is pure and tested here case by case; `schema-readiness.integration.spec.ts` asks a real database
 * the same questions.
 */

const done = (name: string): MigrationRow => ({
  migration_name: name,
  finished: true,
  rolled_back: false,
});
const EXPECTED = ['20260101000000_a', '20260102000000_b', '20260103000000_c'];
const POST = [
  { file: '01-tenant-isolation.sql', sha256: 'a'.repeat(64) },
  { file: '02-audit-immutability.sql', sha256: 'b'.repeat(64) },
];
const BUILD: BuildSchema = { migrations: EXPECTED, postMigrate: POST };
const entry = (row: { file: string; sha256: string }) => `${row.file}:${row.sha256}`;
/** Facts of a fully migrated database whose last post-migration run followed every migration. */
const facts = (over: Partial<Parameters<typeof evaluateSchema>[0]> = {}) => ({
  historyReadable: true,
  rows: EXPECTED.map(done),
  postMigrateReadable: true,
  latestRun: { files: POST.map(entry), migrations: EXPECTED },
  everApplied: POST.map(entry),
  unprotectedTables: [],
  ...over,
});

describe('evaluateSchema', () => {
  it('is ready when every migration finished and every tenant table is protected', () => {
    const result = evaluateSchema(facts(), BUILD);
    expect(result).toEqual({ ready: true, problems: [], expected: 3, applied: 3, unknown: [] });
  });

  it('refuses a database with no migration history', () => {
    const result = evaluateSchema(facts({ historyReadable: false, rows: [] }), BUILD);
    expect(result.ready).toBe(false);
    expect(result.problems.join()).toMatch(/no readable migration history/);
  });

  it('refuses pending migrations and names the first', () => {
    const result = evaluateSchema(facts({ rows: [done(EXPECTED[0] ?? '')] }), BUILD);
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual([
      '2 of 3 migration(s) not applied, the first being 20260102000000_b',
    ]);
  });

  it('refuses a failed or still-running migration even if a later one is recorded', () => {
    const result = evaluateSchema(
      facts({
        rows: [
          done(EXPECTED[0] ?? ''),
          { migration_name: EXPECTED[1] ?? '', finished: false, rolled_back: false },
        ],
      }),
      BUILD,
    );
    expect(result.ready).toBe(false);
    expect(result.problems[0]).toBe('migration(s) failed or still running: 20260102000000_b');
  });

  it('does not count a rolled-back attempt as applied, nor as failed once re-applied', () => {
    const rolledBack = { migration_name: EXPECTED[2] ?? '', finished: false, rolled_back: true };
    const pending = evaluateSchema(
      facts({ rows: [done(EXPECTED[0] ?? ''), done(EXPECTED[1] ?? ''), rolledBack] }),
      BUILD,
    );
    expect(pending.ready).toBe(false);
    expect(pending.problems).toEqual([
      '1 of 3 migration(s) not applied, the first being 20260103000000_c',
    ]);

    const reapplied = evaluateSchema(facts({ rows: [...EXPECTED.map(done), rolledBack] }), BUILD);
    expect(reapplied.ready).toBe(true);
  });

  it('refuses when the post-migration row-level security is missing', () => {
    const result = evaluateSchema(facts({ unprotectedTables: ['document', 'user'] }), BUILD);
    expect(result.ready).toBe(false);
    expect(result.problems[0]).toMatch(/without forced row-level security.*document, user/);
  });

  it('allows a database ahead of this build (the expand-only rollback) and reports it', () => {
    // The newer build changed 01 and ran after its own migration: this older build's 01 is found in
    // an earlier completed run.
    const newer = { file: '01-tenant-isolation.sql', sha256: 'c'.repeat(64) };
    const result = evaluateSchema(
      facts({
        rows: [...EXPECTED.map(done), done('20270101000000_newer')],
        latestRun: {
          files: [entry(newer), entry(POST[1] ?? newer)],
          migrations: [...EXPECTED, '20270101000000_newer'],
        },
        everApplied: [...POST.map(entry), entry(newer)],
      }),
      BUILD,
    );
    expect(result.ready).toBe(true);
    expect(result.unknown).toEqual(['20270101000000_newer']);
  });

  it('refuses a migration applied after the last completed post-migration run', () => {
    // Release N+1 adds a migration with the post-migration files unchanged; its run of them failed
    // (or was skipped). The record from release N still matches every file.
    const result = evaluateSchema(
      facts({
        rows: [...EXPECTED.map(done), done('20260104000000_d')],
        latestRun: { files: POST.map(entry), migrations: EXPECTED },
      }),
      { migrations: [...EXPECTED, '20260104000000_d'], postMigrate: POST },
    );
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual([
      'the post-migration SQL has not completed since 1 migration(s) were applied, the first ' +
        'being 20260104000000_d: the last migration run did not finish',
    ]);
  });

  it('refuses a file reverted to a version an earlier run applied, when the last run did not', () => {
    // v1 applied, then v2, then back to v1 whose run failed: v1 is in the history, not the last run.
    const v2 = { file: '02-audit-immutability.sql', sha256: 'e'.repeat(64) };
    const result = evaluateSchema(
      facts({
        latestRun: { files: [entry(POST[0] ?? v2), entry(v2)], migrations: EXPECTED },
        everApplied: [...POST.map(entry), entry(v2)],
      }),
      BUILD,
    );
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual([
      'post-migration SQL of this build not applied (never run, failed, or changed since): ' +
        '02-audit-immutability.sql',
    ]);
  });

  it('refuses when the build carries no migrations at all', () => {
    const result = evaluateSchema(facts({ rows: [] }), { migrations: [], postMigrate: POST });
    expect(result.ready).toBe(false);
    expect(result.problems[0]).toMatch(/carries no migrations/);
  });

  it('refuses when the build carries no post-migration SQL', () => {
    const result = evaluateSchema(facts(), { migrations: EXPECTED, postMigrate: [] });
    expect(result.ready).toBe(false);
    expect(result.problems[0]).toMatch(/carries no post-migration SQL/);
  });

  it('refuses when the post-migration SQL was never recorded, even with RLS in place', () => {
    for (const over of [
      { postMigrateReadable: false, latestRun: undefined, everApplied: [] },
      { latestRun: undefined, everApplied: [] },
    ]) {
      const result = evaluateSchema(facts(over), BUILD);
      expect(result.ready).toBe(false);
      expect(result.problems).toEqual([
        'the post-migration SQL is not recorded as applied (munaxa_meta.post_migrate_run is ' +
          'missing, empty or unreadable): the migration did not finish',
      ]);
    }
  });

  it('refuses a post-migration file that did not apply or has changed, naming it', () => {
    const changed = { file: '02-audit-immutability.sql', sha256: 'd'.repeat(64) };
    const result = evaluateSchema(
      facts({
        latestRun: {
          files: POST.slice(0, 1).map(entry).concat(entry(changed)),
          migrations: EXPECTED,
        },
      }),
      BUILD,
    );
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual([
      'post-migration SQL of this build not applied (never run, failed, or changed since): ' +
        '02-audit-immutability.sql',
    ]);
  });
});

describe('checkSchemaReadiness', () => {
  function querier(answers: Map<string, unknown[]>): RawQuerier & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      $queryRawUnsafe<T>(query: string): Promise<T> {
        asked.push(query);
        return Promise.resolve((answers.get(query) ?? []) as T);
      },
    };
  }

  it('does not read the history it cannot read, and only ever reads', async () => {
    const db = querier(new Map([[HISTORY_READABLE_SQL, [{ readable: false }]]]));
    const result = await checkSchemaReadiness(db, BUILD);
    expect(result.ready).toBe(false);
    expect(db.asked).toEqual([
      HISTORY_READABLE_SQL,
      POST_MIGRATE_READABLE_SQL,
      UNPROTECTED_TABLES_SQL,
    ]);
    for (const query of db.asked) {
      expect(query).toMatch(/^\s*SELECT/);
    }
  });

  it('passes a fully migrated database', async () => {
    const db = querier(
      new Map<string, unknown[]>([
        [HISTORY_READABLE_SQL, [{ readable: true }]],
        [MIGRATION_ROWS_SQL, EXPECTED.map(done)],
        [POST_MIGRATE_READABLE_SQL, [{ readable: true }]],
        [LATEST_RUN_SQL, [{ files: POST.map(entry), migrations: EXPECTED }]],
        [EVER_APPLIED_SQL, POST.map((row) => ({ entry: entry(row) }))],
        [UNPROTECTED_TABLES_SQL, []],
      ]),
    );
    expect((await checkSchemaReadiness(db, BUILD)).ready).toBe(true);
  });
});

describe('expectedMigrations', () => {
  it('lists the directories holding a migration.sql, in order', () => {
    const root = mkdtempSync(join(tmpdir(), 'dc01-'));
    for (const name of ['20260102_b', '20260101_a']) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'migration.sql'), 'SELECT 1;');
    }
    mkdirSync(join(root, 'not-a-migration'));
    writeFileSync(join(root, 'migration_lock.toml'), 'provider = "postgresql"');
    expect(expectedMigrations(root)).toEqual(['20260101_a', '20260102_b']);
  });

  it('finds the repository migrations, the same set prisma migrate deploy applies', () => {
    const found = expectedMigrations(locateMigrations());
    expect(found.length).toBeGreaterThan(30);
    expect(found[0]).toBe('20260803161711_init');
  });

  it('is empty for a directory that does not exist, which the gate then refuses', () => {
    expect(expectedMigrations('/nonexistent/prisma/migrations')).toEqual([]);
  });
});

describe('expectedPostMigrate', () => {
  it('hashes the repository post-migration files the way apply-post-migrate.mjs records them', () => {
    const found = expectedPostMigrate(locatePostMigrate());
    expect(found.map((row) => row.file)).toEqual([
      '01-tenant-isolation.sql',
      '02-audit-immutability.sql',
      '03-content-gate.sql',
      '04-workflow-integrity.sql',
    ]);
    for (const row of found) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('is empty for a directory that does not exist, which the gate then refuses', () => {
    expect(expectedPostMigrate('/nonexistent/infra/sql/post-migrate')).toEqual([]);
  });
});

describe('SchemaNotReadyError', () => {
  it('names the tenant and the problem, and never a connection string', () => {
    const error = new SchemaNotReadyError('acme', {
      ready: false,
      problems: [
        'the database has no readable migration history (_prisma_migrations): it is not migrated',
      ],
      expected: 3,
      applied: 0,
      unknown: [],
    });
    expect(error.message).toMatch(/'acme' is not migrated/);
    expect(error.message).not.toMatch(/postgres(ql)?:\/\//);
  });
});
