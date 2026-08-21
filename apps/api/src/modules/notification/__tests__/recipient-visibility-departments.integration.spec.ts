import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type DocumentId,
  Permission,
  ScopeType,
  type TenantId,
  type UserId,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import type { AuthorizationSubject } from '../../../core/authorization/acl-resolver.port';

import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { type NotificationStack, realNotifications } from '../../../testing/real-collaborators';
import { sharedDatabase } from '../../../testing/tenant-database';
import type { DocumentService } from '../../document/application/ports';

/**
 * Whether a notification recipient is judged by the same rule a caller is — Slice 23.
 *
 * ## The invariant
 *
 * `RecipientVisibilityService`'s docstring says what it is: *"the existing `resolve` asked about
 * somebody other than the caller"*, and `18-notification-architecture.md` §4 requires every
 * document-derived recipient list to pass through `ACL_RESOLVER`. Both sentences mean one thing —
 * the answer for a person as a *recipient* must equal the answer for that same person as a
 * *caller*. Anything else is a second authorization model nobody declared.
 *
 * ## The divergence
 *
 * `PrismaAclResolver.departmentsOf` has two branches. Supplied a non-empty `departmentIds` it
 * returns them verbatim; given an empty one it queries the department table with
 * `deletedAt: null` and expands the **materialised path**, so a member of `Quality/Audit` also
 * carries `Quality`.
 *
 * `AclGuard.subjectFor` passes `departmentIds: []`, and so does every other construction of an
 * `AuthorizationSubject` in the product — reporting, retention, the permission service, the
 * document repository. `RecipientVisibilityService` was the only caller that supplied them, from
 * `authorizationSubjectFor`, which reads `user_department` rows raw. So it alone took the branch
 * that skips the ancestry, and a recipient whose reach comes from an entry on a **parent**
 * department was judged unable to see a document they can in fact open — and silently dropped
 * from the notification. §4's rows say those people must be told.
 *
 * ## Why a real database
 *
 * The claim is that two code paths through the same resolver disagree, and the thing they disagree
 * about is a materialised path expanded by a SQL query. A double for the resolver would assert the
 * behaviour under test.
 */

const APP_URL = process.env['DATABASE_URL'] ?? '';
const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';

const config = {
  env: 'test',
  database: { url: APP_URL, poolSize: 10 },
  acl: { maxSubjectEntries: 500, decisionTtlSeconds: 0, filterTtlSeconds: 0 },
} as unknown as AppConfig;

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const FIXED_NOW = new Date('2026-06-01T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };

const prisma = sharedDatabase(config, logger, APP_URL);
const unitOfWork = new PrismaUnitOfWork(prisma);
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });

/**
 * A cache that stores nothing.
 *
 * `PrismaAclResolver.decisionKey` is built from the tenant, the user, the **roles**, the scope and
 * the permission — `departmentIds` is not in it. Two subjects for the same person that differ only
 * in their departments therefore share one entry, so a resolver backed by a real cache answers the
 * second question with the first one's answer and any probe of the two branches measures the cache.
 * That cost an hour of this slice; nothing is stored here so each call is measured.
 */
const noCache = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  deleteByPrefix: () => Promise.resolve(0),
  increment: () => Promise.resolve(0),
};

/**
 * Document's surface, stood in for — the same stand-in `notification.integration.spec.ts` uses and
 * for the same reason: this suite is about what Notification asks the ACL resolver, not about
 * whether Document reads its own table. The visibility half is emphatically real.
 */
const documents = {
  get: () => Promise.resolve(null),
  exists: () => Promise.resolve(true),
  availableTransitions: () => Promise.resolve([]),
  restore: () => Promise.resolve(),
  expireEffective: () => Promise.resolve({ examined: 0, expired: 0 }),
} as unknown as DocumentService;

let stack: NotificationStack;

const TENANT = asId<TenantId>(uuidv7());
const DOCUMENT = asId<DocumentId>(uuidv7());
/** In the child department only. Their reach comes from the entry on its parent. */
const AUDITOR_IN_CHILD = asId<UserId>(uuidv7());
/** In no department at all, and named by no entry. The control. */
const OUTSIDER = asId<UserId>(uuidv7());

let parentDepartmentId: string;
let childDepartmentId: string;

function contextFor(userId: UserId | null): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: [],
    permissions: [],
    sessionId: null,
    correlationId: 'recipient-visibility-departments',
    permissionVersion: 1,
    locale: 'en',
  };
}

function inTenant<T>(work: () => Promise<T>): Promise<T> {
  return runWithContext(contextFor(null), work);
}

/**
 * The visibility service reads the recipient's subject through `USER_DIRECTORY`, which uses
 * `requireTransaction()` — so it needs a unit of work opened around it, exactly as the queue
 * consumer that calls it in production does. The resolver opens its own; the directory does not.
 */
function inUnitOfWork<T>(work: () => Promise<T>): Promise<T> {
  return inTenant(() => unitOfWork.run(work));
}

/** Exactly the subject `AclGuard.subjectFor` builds: no departments, resolver computes them. */
function asCaller(userId: UserId): AuthorizationSubject {
  return { userId, roleIds: [], departmentIds: [], delegationIds: [] };
}

beforeAll(async () => {
  if (!APP_URL || !OWNER_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }

  stack = realNotifications({ clock, unitOfWork, config, documents, cache: noCache });

  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `recipient-vis-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'Recipient visibility fixture',
      status: 'ACTIVE',
    },
  });

  const companyId = uuidv7();
  const entityId = uuidv7();
  parentDepartmentId = uuidv7();
  childDepartmentId = uuidv7();

  await owner.company.create({
    data: { id: companyId, tenantId: TENANT, code: 'CO', name: 'Acme', updatedAt: FIXED_NOW },
  });
  await owner.entity.create({
    data: {
      id: entityId,
      tenantId: TENANT,
      companyId,
      code: 'EN',
      name: 'Acme Manufacturing',
      updatedAt: FIXED_NOW,
    },
  });
  // `path` materialises the ancestry as ids joined by the separator — the child's own path carries
  // its parent, which is the whole subject of this file.
  await owner.department.create({
    data: {
      id: parentDepartmentId,
      tenantId: TENANT,
      entityId,
      code: 'QA',
      name: 'Quality',
      path: parentDepartmentId,
      updatedAt: FIXED_NOW,
    },
  });
  await owner.department.create({
    data: {
      id: childDepartmentId,
      tenantId: TENANT,
      entityId,
      parentId: parentDepartmentId,
      code: 'QA-AUD',
      name: 'Quality Audit',
      path: `${parentDepartmentId}.${childDepartmentId}`,
      updatedAt: FIXED_NOW,
    },
  });

  for (const [id, name] of [
    [AUDITOR_IN_CHILD, 'Auditor In Child'],
    [OUTSIDER, 'Outsider'],
  ] as const) {
    const email = `${id}@recipient-vis.test`;
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email,
        emailNormalized: email,
        displayName: name,
        status: 'ACTIVE',
      },
    });
  }
  await owner.userDepartment.create({
    data: { tenantId: TENANT, userId: AUDITOR_IN_CHILD, departmentId: childDepartmentId },
  });

  // Tenant → library → root folder → document: the smallest chain the ACL walk can cross.
  const libraryId = uuidv7();
  const folderId = uuidv7();
  await owner.library.create({
    data: {
      id: libraryId,
      tenantId: TENANT,
      code: 'LIB',
      name: 'Quality Library',
      ownerScopeType: 'TENANT',
      rootFolderId: null,
      updatedAt: FIXED_NOW,
    },
  });
  await owner.folder.create({
    data: {
      id: folderId,
      tenantId: TENANT,
      libraryId,
      name: 'Root',
      path: folderId,
      isRoot: true,
      updatedAt: FIXED_NOW,
    },
  });
  await owner.library.update({ where: { id: libraryId }, data: { rootFolderId: folderId } });

  const confidentialityId = uuidv7();
  const numberingRuleId = uuidv7();
  const documentTypeId = uuidv7();
  await owner.confidentialityLevel.create({
    data: {
      id: confidentialityId,
      tenantId: TENANT,
      code: 'INTERNAL',
      name: 'Internal',
      rank: 1,
      updatedAt: FIXED_NOW,
    },
  });
  await owner.numberingRule.create({
    data: {
      id: numberingRuleId,
      tenantId: TENANT,
      key: 'default',
      name: 'Default',
      segments: [],
      updatedAt: FIXED_NOW,
    },
  });
  await owner.documentType.create({
    data: {
      id: documentTypeId,
      tenantId: TENANT,
      code: 'PROC',
      name: 'Procedure',
      numberingRuleId,
      defaultConfidentialityId: confidentialityId,
      updatedAt: FIXED_NOW,
    },
  });
  await owner.document.create({
    data: {
      id: DOCUMENT,
      tenantId: TENANT,
      folderId,
      documentTypeId,
      confidentialityId,
      title: 'Supplier Audit Procedure',
      status: 'DRAFT',
      ownerUserId: OUTSIDER,
      updatedAt: FIXED_NOW,
    },
  });

  // The grant, on the **parent** department. Nobody holds `document:view` tenant-wide here, so this
  // entry is the only reach anybody has, and it reaches the child only through the path.
  await owner.aclEntry.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      scopeType: 'FOLDER',
      scopeId: folderId,
      subjectType: 'DEPARTMENT',
      subjectId: parentDepartmentId,
      permission: Permission.DOCUMENT_VIEW,
      effect: 'ALLOW',
      updatedAt: FIXED_NOW,
    },
  });
}, 120_000);

afterAll(async () => {
  await owner.$disconnect();
  await prisma.disconnectAll();
});

describe('a member of a sub-department, granted through its parent', () => {
  it('may open the document as a caller, which is the answer everything else must match', async () => {
    // The positive state first. Every assertion below compares against this one, and a comparison
    // against a "no" would hold just as well if the entry were never written.
    const decision = await inTenant(() =>
      stack.aclResolver.resolve(
        asCaller(AUDITOR_IN_CHILD),
        { type: ScopeType.DOCUMENT, id: DOCUMENT },
        Permission.DOCUMENT_VIEW,
      ),
    );

    expect(decision.allowed, 'the parent-department grant did not reach the child').toBe(true);
  });

  it('is told the document exists, because a recipient is the same person as a caller', async () => {
    /*
     * The defect. `RecipientVisibilityService` supplied `departmentIds` read raw from
     * `user_department`, which made `departmentsOf` return them verbatim instead of expanding the
     * materialised path — so `Quality` was missing from the subject, the entry did not match, and
     * somebody who can open the document was silently left out of its notification.
     */
    const permitted = await inUnitOfWork(() =>
      stack.visibility.whoMaySee([AUDITOR_IN_CHILD], DOCUMENT),
    );

    expect(permitted).toEqual([AUDITOR_IN_CHILD]);
  });

  it('refuses somebody in no department, so the filter is still a filter', async () => {
    // The other direction, and the assertion that stops the fix from being "permit everybody".
    const decision = await inTenant(() =>
      stack.aclResolver.resolve(
        asCaller(OUTSIDER),
        { type: ScopeType.DOCUMENT, id: DOCUMENT },
        Permission.DOCUMENT_VIEW,
      ),
    );
    const permitted = await inUnitOfWork(() => stack.visibility.whoMaySee([OUTSIDER], DOCUMENT));

    expect(decision.allowed).toBe(false);
    expect(permitted).toEqual([]);
  });

  it('agrees with the resolver for both people asked together', async () => {
    // The invariant stated directly: recipient and caller are one answer, for everybody at once.
    const permitted = await inUnitOfWork(() =>
      stack.visibility.whoMaySee([AUDITOR_IN_CHILD, OUTSIDER], DOCUMENT),
    );

    expect(permitted).toEqual([AUDITOR_IN_CHILD]);
  });
});
