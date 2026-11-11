import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HISTORY_READABLE_SQL,
  MIGRATION_ROWS_SQL,
  type MigrationRow,
  type RawQuerier,
  SchemaNotReadyError,
  UNPROTECTED_TABLES_SQL,
  checkSchemaReadiness,
  evaluateSchema,
  expectedMigrations,
  locateMigrations,
} from './schema-readiness';

/**
 * DC-01: the gate provisioning and API start-up run before touching a tenant database. The decision
 * is pure and tested here case by case; `schema-readiness.integration.spec.ts` asks a real database
 * the same questions.
 */

const EXPECTED = ['20260101000000_a', '20260102000000_b', '20260103000000_c'];
const done = (name: string): MigrationRow => ({
  migration_name: name,
  finished: true,
  rolled_back: false,
});

describe('evaluateSchema', () => {
  it('is ready when every migration finished and every tenant table is protected', () => {
    const result = evaluateSchema(
      { historyReadable: true, rows: EXPECTED.map(done), unprotectedTables: [] },
      EXPECTED,
    );
    expect(result).toEqual({ ready: true, problems: [], expected: 3, applied: 3, unknown: [] });
  });

  it('refuses a database with no migration history', () => {
    const result = evaluateSchema(
      { historyReadable: false, rows: [], unprotectedTables: [] },
      EXPECTED,
    );
    expect(result.ready).toBe(false);
    expect(result.problems.join()).toMatch(/no readable migration history/);
  });

  it('refuses pending migrations and names the first', () => {
    const result = evaluateSchema(
      { historyReadable: true, rows: [done(EXPECTED[0] ?? '')], unprotectedTables: [] },
      EXPECTED,
    );
    expect(result.ready).toBe(false);
    expect(result.problems).toEqual([
      '2 of 3 migration(s) not applied, the first being 20260102000000_b',
    ]);
  });

  it('refuses a failed or still-running migration even if a later one is recorded', () => {
    const result = evaluateSchema(
      {
        historyReadable: true,
        rows: [
          done(EXPECTED[0] ?? ''),
          { migration_name: EXPECTED[1] ?? '', finished: false, rolled_back: false },
        ],
        unprotectedTables: [],
      },
      EXPECTED,
    );
    expect(result.ready).toBe(false);
    expect(result.problems[0]).toBe('migration(s) failed or still running: 20260102000000_b');
  });

  it('does not count a rolled-back attempt as applied, nor as failed once re-applied', () => {
    const rolledBack = { migration_name: EXPECTED[2] ?? '', finished: false, rolled_back: true };
    const pending = evaluateSchema(
      {
        historyReadable: true,
        rows: [done(EXPECTED[0] ?? ''), done(EXPECTED[1] ?? ''), rolledBack],
        unprotectedTables: [],
      },
      EXPECTED,
    );
    expect(pending.ready).toBe(false);
    expect(pending.problems).toEqual([
      '1 of 3 migration(s) not applied, the first being 20260103000000_c',
    ]);

    const reapplied = evaluateSchema(
      { historyReadable: true, rows: [...EXPECTED.map(done), rolledBack], unprotectedTables: [] },
      EXPECTED,
    );
    expect(reapplied.ready).toBe(true);
  });

  it('refuses when the post-migration row-level security is missing', () => {
    const result = evaluateSchema(
      { historyReadable: true, rows: EXPECTED.map(done), unprotectedTables: ['document', 'user'] },
      EXPECTED,
    );
    expect(result.ready).toBe(false);
    expect(result.problems[0]).toMatch(/without forced row-level security.*document, user/);
  });

  it('allows a database ahead of this build (the expand-only rollback) and reports it', () => {
    const result = evaluateSchema(
      {
        historyReadable: true,
        rows: [...EXPECTED.map(done), done('20270101000000_newer')],
        unprotectedTables: [],
      },
      EXPECTED,
    );
    expect(result.ready).toBe(true);
    expect(result.unknown).toEqual(['20270101000000_newer']);
  });

  it('refuses when the build carries no migrations at all', () => {
    const result = evaluateSchema({ historyReadable: true, rows: [], unprotectedTables: [] }, []);
    expect(result.ready).toBe(false);
    expect(result.problems[0]).toMatch(/carries no migrations/);
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
    const result = await checkSchemaReadiness(db, EXPECTED);
    expect(result.ready).toBe(false);
    expect(db.asked).toEqual([HISTORY_READABLE_SQL, UNPROTECTED_TABLES_SQL]);
    for (const query of db.asked) {
      expect(query).toMatch(/^\s*SELECT/);
    }
  });

  it('passes a fully migrated database', async () => {
    const db = querier(
      new Map<string, unknown[]>([
        [HISTORY_READABLE_SQL, [{ readable: true }]],
        [MIGRATION_ROWS_SQL, EXPECTED.map(done)],
        [UNPROTECTED_TABLES_SQL, []],
      ]),
    );
    expect((await checkSchemaReadiness(db, EXPECTED)).ready).toBe(true);
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
