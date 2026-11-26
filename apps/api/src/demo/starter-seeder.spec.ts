import { describe, expect, it } from 'vitest';

import {
  STARTER_CONFIDENTIALITY,
  STARTER_DOCUMENT_TYPES,
  STARTER_LIBRARIES,
} from './starter-catalogue';
import { StarterSeeder, type StarterServices } from './starter-seeder';

/**
 * The seeder's own rules, over in-memory services: additive, re-runnable, respectful of what an
 * administrator retired, and silent in a dry run. That every item is *valid* is the catalogue
 * spec's job; that the real services accept it is the integration run's.
 */

interface Row {
  id: string;
  code?: string;
  key?: string;
  deletedAt: Date | null;
  createdAt: Date;
  [field: string]: unknown;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `00000000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
}

function page(rows: readonly Row[]) {
  return Promise.resolve({
    data: rows,
    meta: { page: 1, pageSize: 100, total: rows.length, hasMore: false },
  });
}

function fakeServices() {
  const tables: Record<string, Row[]> = {
    entities: [{ id: nextId(), code: 'HQ', deletedAt: null, createdAt: new Date(0) }],
    departments: [],
    confidentiality: [],
    retention: [],
    categories: [],
    fields: [],
    types: [],
    rules: [],
    groups: [],
    workflows: [],
    libraries: [],
    folders: [],
  };
  const calls: string[] = [];
  const ADMIN = '00000000-0000-7000-8000-00000000a0a0';
  const APPROVER_ROLE = { id: '00000000-0000-7000-8000-0000000000a2', key: 'APPROVER' };
  const roles: { id: string; key: string; deletedAt: Date | null }[] = [
    { id: '00000000-0000-7000-8000-0000000000a1', key: 'TENANT_ADMIN', deletedAt: null },
    { ...APPROVER_ROLE, deletedAt: null },
  ];
  const users: Record<string, { roles: { id: string; key: string }[]; version: number }> = {
    [ADMIN]: {
      roles: [{ id: '00000000-0000-7000-8000-0000000000a1', key: 'TENANT_ADMIN' }],
      version: 3,
    },
  };

  function insert(table: string, body: Record<string, unknown>): Row {
    const row: Row = { ...body, id: nextId(), deletedAt: null, createdAt: new Date() };
    tables[table]?.push(row);
    calls.push(`${table}:${String(body['code'] ?? body['key'] ?? body['name'])}`);
    return row;
  }

  const services = {
    scopes: {
      listEntities: () => page(tables['entities'] ?? []),
      listDepartments: () => page(tables['departments'] ?? []),
      createDepartment: (body: Record<string, unknown>) =>
        Promise.resolve(insert('departments', body)),
    },
    config: {
      listConfidentiality: () => page(tables['confidentiality'] ?? []),
      createConfidentiality: (body: Record<string, unknown>) =>
        Promise.resolve(insert('confidentiality', body)),
      listRetention: () => page(tables['retention'] ?? []),
      createRetention: (body: Record<string, unknown>) =>
        Promise.resolve(insert('retention', body)),
      listCategories: () => page(tables['categories'] ?? []),
      createCategory: (body: Record<string, unknown>) =>
        Promise.resolve(insert('categories', body)),
      listMetadataFields: () => page(tables['fields'] ?? []),
      createMetadataField: (body: Record<string, unknown>) =>
        Promise.resolve(insert('fields', body)),
      listDocumentTypes: () => page(tables['types'] ?? []),
      createDocumentType: (body: Record<string, unknown>) => Promise.resolve(insert('types', body)),
    },
    numbering: {
      list: () => page(tables['rules'] ?? []),
      create: (body: Record<string, unknown>) => Promise.resolve(insert('rules', body)),
    },
    routing: {
      listGroups: () => page(tables['groups'] ?? []),
      createGroup: (body: Record<string, unknown>) => {
        const row = insert('groups', body);
        row['members'] = ((body['memberIds'] as string[] | undefined) ?? []).map((userId) => ({
          userId,
        }));
        return Promise.resolve(row);
      },
    },
    workflows: {
      list: () => page(tables['workflows'] ?? []),
      create: (body: Record<string, unknown>) => {
        const row = insert('workflows', body);
        row['versions'] = [{ id: nextId() }];
        row['recordVersion'] = 1;
        row['publishedVersion'] = null;
        return Promise.resolve(row);
      },
      publish: (id: string) => {
        const row = (tables['workflows'] ?? []).find((entry) => entry.id === id);
        if (row) {
          row['publishedVersion'] = 1;
        }
        calls.push('publish');
        return Promise.resolve(row);
      },
    },
    libraries: {
      listLibraries: () => page(tables['libraries'] ?? []),
      createLibrary: (body: Record<string, unknown>) => {
        const row = insert('libraries', body);
        tables['folders']?.push({
          id: nextId(),
          libraryId: row.id,
          isRoot: true,
          name: String(body['name']),
          deletedAt: null,
          createdAt: new Date(),
        });
        return Promise.resolve(row);
      },
      listFolders: (request: { libraryId?: string }) =>
        page(
          (tables['folders'] ?? []).filter((folder) => folder['libraryId'] === request.libraryId),
        ),
      createFolder: (body: Record<string, unknown>) => {
        const row: Row = {
          ...body,
          id: nextId(),
          isRoot: false,
          deletedAt: null,
          createdAt: new Date(),
        };
        tables['folders']?.push(row);
        calls.push(`folders:${String(body['name'])}`);
        return Promise.resolve(row);
      },
    },
    roles: { list: () => page(roles as unknown as Row[]) },
    users: {
      get: (id: string) => {
        const user = users[id];
        return Promise.resolve({
          id,
          deletedAt: null,
          roles: user?.roles ?? [],
          version: user?.version,
        });
      },
      update: (id: string, patch: { roleIds: string[] }, version: number) => {
        const user = users[id];
        if (user === undefined || user.version !== version) {
          return Promise.reject(new Error('stale'));
        }
        user.roles = patch.roleIds.map((roleId) => ({
          id: roleId,
          key: roles.find((role) => role.id === roleId)?.key ?? '?',
        }));
        user.version += 1;
        calls.push(`users:${id}:roles`);
        return Promise.resolve({ id });
      },
    },
    administrators: () => Promise.resolve([ADMIN]),
  };

  return {
    services: services as unknown as StarterServices,
    tables,
    calls,
    users,
    roles,
    ADMIN,
    APPROVER_ROLE,
  };
}

describe('the starter seeder', () => {
  it('creates the whole catalogue into an empty tenant', async () => {
    const { services, tables, calls } = fakeServices();

    const result = await new StarterSeeder(services, { dryRun: false }).run();

    expect(result.skipped).toBe(0);
    expect(result.existing).toBe(0);
    expect(tables['types']).toHaveLength(STARTER_DOCUMENT_TYPES.length);
    expect(tables['libraries']).toHaveLength(STARTER_LIBRARIES.length);
    expect(calls).toContain('publish');
    // Controlled types are attached to the published workflow; reference types are not.
    const policy = tables['types']?.find((row) => row.code === 'POL');
    const invoice = tables['types']?.find((row) => row.code === 'INV');
    expect(policy?.['workflowDefinitionId']).toBe(tables['workflows']?.[0]?.id);
    expect(invoice?.['workflowDefinitionId']).toBeNull();
    // The approval group starts with the administrators, so one person can try an approval.
    expect(tables['groups']?.[0]?.['memberIds']).toEqual(['00000000-0000-7000-8000-00000000a0a0']);
  });

  it('creates nothing on a second run', async () => {
    const { services, calls } = fakeServices();
    await new StarterSeeder(services, { dryRun: false }).run();
    const before = calls.length;

    const second = await new StarterSeeder(services, { dryRun: false }).run();

    expect(second.created).toBe(0);
    expect(second.skipped).toBe(0);
    expect(calls).toHaveLength(before);
  });

  it('writes nothing in a dry run, and reports what it would create', async () => {
    const { services, calls } = fakeServices();

    const result = await new StarterSeeder(services, { dryRun: true }).run();

    expect(calls).toEqual([]);
    expect(result.created).toBeGreaterThan(30);
  });

  it('leaves an existing item alone and reuses it as a reference', async () => {
    const { services, tables, calls } = fakeServices();
    const mine: Row = { id: nextId(), code: 'INTERNAL', deletedAt: null, createdAt: new Date() };
    tables['confidentiality']?.push(mine);

    await new StarterSeeder(services, { dryRun: false }).run();

    expect(calls).not.toContain('confidentiality:INTERNAL');
    expect(tables['confidentiality']).toHaveLength(STARTER_CONFIDENTIALITY.length);
    expect(tables['types']?.find((row) => row.code === 'POL')?.['defaultConfidentialityId']).toBe(
      mine.id,
    );
  });

  it('never restores what an administrator retired, and skips what needs it', async () => {
    const { services, tables, calls } = fakeServices();
    tables['rules']?.push({
      id: nextId(),
      key: 'yearly-record',
      deletedAt: new Date(),
      createdAt: new Date(),
    });

    const result = await new StarterSeeder(services, { dryRun: false }).run();

    expect(calls).not.toContain('rules:yearly-record');
    const skippedTypes = result.steps
      .filter((step) => step.kind === 'document type' && step.outcome === 'skipped')
      .map((step) => step.code);
    expect(skippedTypes.sort()).toEqual(['CTR', 'INV', 'RPT']);
  });

  it('adds no folders to a library that already existed', async () => {
    const { services, tables, calls } = fakeServices();
    tables['libraries']?.push({
      id: nextId(),
      code: 'QMS',
      deletedAt: null,
      createdAt: new Date(),
    });

    await new StarterSeeder(services, { dryRun: false }).run();

    expect(calls).not.toContain('folders:Procedures');
    expect(calls).toContain('folders:Contracts');
  });

  // --- The approver the starter group routes to can decide (26 Nov 2026 fix) ----------------

  it('gives the administrators in the starter group the Approver role, keeping their others', async () => {
    const { services, users, calls, ADMIN, APPROVER_ROLE } = fakeServices();

    const result = await new StarterSeeder(services, { dryRun: false }).run();

    expect(users[ADMIN]?.roles.map((role) => role.key).sort()).toEqual([
      'APPROVER',
      'TENANT_ADMIN',
    ]);
    expect(users[ADMIN]?.roles.map((role) => role.id)).toContain(APPROVER_ROLE.id);
    expect(calls.filter((call) => call === `users:${ADMIN}:roles`)).toHaveLength(1);
    expect(result.steps).toContainEqual({
      kind: 'approver role',
      code: ADMIN,
      outcome: 'created',
      note: 'granted',
    });
  });

  it('grants the role on a re-run into a tenant seeded before the fix, and only once', async () => {
    const { services, tables, users, calls, ADMIN } = fakeServices();
    // The state Testing was left in: the group exists with the administrator, who lacks the role.
    tables['groups']?.push({
      id: nextId(),
      key: 'document-approvers',
      members: [{ userId: ADMIN }, { userId: '00000000-0000-7000-8000-0000000000b0' }],
      deletedAt: null,
      createdAt: new Date(),
    });

    await new StarterSeeder(services, { dryRun: false }).run();
    expect(users[ADMIN]?.roles.map((role) => role.key)).toContain('APPROVER');

    const before = calls.length;
    const second = await new StarterSeeder(services, { dryRun: false }).run();
    expect(calls).toHaveLength(before);
    expect(second.created).toBe(0);
    expect(second.steps).toContainEqual({ kind: 'approver role', code: ADMIN, outcome: 'exists' });
    // A non-administrator member is never touched.
    expect(second.steps.some((step) => step.code === '00000000-0000-7000-8000-0000000000b0')).toBe(
      false,
    );
  });

  it('leaves an administrator an administrator removed from the group alone', async () => {
    const { services, tables, users, ADMIN } = fakeServices();
    tables['groups']?.push({
      id: nextId(),
      key: 'document-approvers',
      members: [],
      deletedAt: null,
      createdAt: new Date(),
    });

    await new StarterSeeder(services, { dryRun: false }).run();

    expect(users[ADMIN]?.roles.map((role) => role.key)).toEqual(['TENANT_ADMIN']);
  });

  it('grants nothing when the Approver role was retired, and says why', async () => {
    const { services, roles, users, ADMIN } = fakeServices();
    const approver = roles.find((role) => role.key === 'APPROVER');
    if (approver) {
      approver.deletedAt = new Date();
    }

    const result = await new StarterSeeder(services, { dryRun: false }).run();

    expect(users[ADMIN]?.roles.map((role) => role.key)).toEqual(['TENANT_ADMIN']);
    expect(result.steps).toContainEqual({
      kind: 'approver role',
      code: ADMIN,
      outcome: 'skipped',
      note: 'retired by an administrator',
    });
  });

  it('grants nothing in a dry run, and reports that it would', async () => {
    const { services, users, ADMIN } = fakeServices();

    const result = await new StarterSeeder(services, { dryRun: true }).run();

    expect(users[ADMIN]?.roles.map((role) => role.key)).toEqual(['TENANT_ADMIN']);
    expect(result.steps).toContainEqual({
      kind: 'approver role',
      code: ADMIN,
      outcome: 'created',
      note: 'dry run: would grant',
    });
  });
});
