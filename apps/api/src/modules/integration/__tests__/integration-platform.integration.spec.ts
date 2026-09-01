import 'reflect-metadata';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AnyId,
  type ScopeRef,
  type TenantId,
  type UserId,
  AclEffect,
  AclSubjectType,
  ApiScope,
  Permission,
  NumberSegmentKind,
  RevisionLabelStyle,
  ScopeType,
  Settings,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  asId,
  parseApiKey,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import type { AppConfig } from '../../../core/config/configuration';
import type { Logger } from '../../../core/observability/logger';
import { PrismaUnitOfWork } from '../../../core/prisma/unit-of-work';
import { type RequestContext, runWithContext } from '../../../core/tenancy/tenant-context';
import { seedRoleGrant } from '../../../testing/acl-seed';
import {
  PrismaApiClientRepository,
  type ApiClientStack,
  type AuditSinkStack,
  type DocumentLibraryStack,
  type WebhookStack,
  RecordingHttp,
  isPublicAddress,
  realApiClients,
  realAuditSink,
  realDocumentLibrary,
  realFederatedUsers,
  realOutboundHttp,
  realPermissions,
  realWebhooks,
  realWriteStack,
} from '../../../testing/real-collaborators';
import { everyTenantRegistry, sharedDatabase } from '../../../testing/tenant-database';
import { verifyWebhookSignature } from '../application/webhook-delivery.service';

/**
 * Phase 17 against a real PostgreSQL — the five assertions the brief names, and each is a
 * database question or a cryptographic one.
 *
 * ## Why these five
 *
 * **A machine token reaches exactly what its subject reaches.** This is the phase's data-breach
 * question. `PrismaDocumentRepository.visibilityCondition` answers a subject-less caller with an
 * **empty predicate**, which is every document in the tenant — Phase 15 found that in the export
 * lane and worked around it. If an API key had authenticated with `userId: null`, every list route
 * in the product would have become a full tenant dump for anybody holding a key. So the suite
 * asserts both halves: a key bound to Ada sees what Ada sees, and a key bound to Ben — who is
 * denied a folder — sees strictly less, **from the same list call**.
 *
 * **A webhook is signed and verifiable by a receiver.** Asserted with `verifyWebhookSignature`,
 * which is written from the documented scheme rather than by calling the sender's own `createHmac`
 * — asserting that a function equals itself would prove nothing about whether a customer can
 * verify what we send.
 *
 * **A webhook is retried and dead-lettered without losing the event.** The row and its payload
 * survive every failure, which is what makes a manual replay possible a week later.
 *
 * **An SSO sign-in provisions to pre-mapped roles and grants no more than the mapping says.**
 *
 * **An outbound URL is refused when it is not on the allow-list** — against the *real*
 * `AllowListedHttpAdapter`, because that is where the decision lives. A fake with its own
 * allow-list would let the suite prove a refusal the real class never made.
 *
 * ## The ACL entries are written as a request writes them
 *
 * CI's `edms_owner` is the cluster superuser, so a suite seeding `acl_entry` with the owner client
 * writes past row-level security and is not testing what a request would see. Phase 14's
 * `acl.integration.spec.ts` recorded this, Phase 15's and Phase 16's suites follow it, and so does
 * this one: every entry goes through `PermissionService` in a request context, and the owner client
 * creates only what a request could not — the tenant, the people and the role grants.
 */

const OWNER_URL = process.env['DATABASE_MIGRATION_URL'] ?? '';
const APP_URL = process.env['DATABASE_URL'] ?? '';

const FIXED_NOW = new Date('2026-08-06T09:00:00.000Z');
const clock = { now: () => new Date(FIXED_NOW), timestamp: () => 0, elapsedMs: () => 0 };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

const TENANT = asId<TenantId>(uuidv7());
/** Reaches both folders. */
const ADA = asId<UserId>(uuidv7());
/** The same role, and an explicit `DENY` on the closed folder — the second reach. */
const BEN = asId<UserId>(uuidv7());
const ADMIN = asId<UserId>(uuidv7());

const AUTHOR_ROLE = uuidv7();
const ADMIN_ROLE = uuidv7();

let appConfig: AppConfig;
let owner: PrismaClient;
let unitOfWork: PrismaUnitOfWork;
let databases: ReturnType<typeof sharedDatabase>;
let library: DocumentLibraryStack;
let permissions: ReturnType<typeof realPermissions>;
let webhooks: WebhookStack;
let apiClients: ApiClientStack;
let sinks: AuditSinkStack;
/**
 * The read-audit buffer the library stack writes through.
 *
 * Held so the channel assertion can flush it deterministically: 13 §5's buffer batches reads and
 * flushes on an interval, and a test that waited for the interval would be a test that sleeps.
 */
let readAudit: ReturnType<typeof realWriteStack>['readAudit'];

let closedFolderId: string;

function contextFor(userId: UserId | null, roles: readonly string[]): RequestContext {
  return {
    tenantId: TENANT,
    userId,
    roles: [...roles],
    permissions: [],
    sessionId: null,
    correlationId: 'integration-suite',
    permissionVersion: 1,
    locale: 'en',
  };
}

const asAdmin = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(ADMIN, [ADMIN_ROLE]), work);
/** No user at all: the shape an authenticator runs in before it has resolved anybody. */
const asNobody = <T>(work: () => Promise<T>): Promise<T> =>
  runWithContext(contextFor(null, []), work);

const page = { page: 1, pageSize: 50 };
const listRequest = { ...page, deleted: 'live' as const, sortDirection: 'asc' as const };
const folderScope = (id: string): ScopeRef => ({ type: ScopeType.FOLDER, id: asId<AnyId>(id) });

beforeAll(async () => {
  if (!OWNER_URL || !APP_URL) {
    throw new Error('DATABASE_URL and DATABASE_MIGRATION_URL must both be set.');
  }

  appConfig = {
    env: 'test',
    database: { url: APP_URL, poolSize: 10 },
    storage: { driver: 'LOCAL', signedUrlTtlSeconds: 300 },
    // No cache: every reach assertion below asks the database twice and expects the same answer.
    acl: { cacheTtlSeconds: 0, maxSubjectEntries: 5_000 },
    outbound: {
      allowList: ['hooks.example.com', '.collectors.example.net'],
      allowInsecure: false,
      maxResponseBytes: 65_536,
    },
  } as unknown as AppConfig;

  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  await owner.tenant.create({
    data: {
      id: TENANT,
      slug: `int-${TENANT.replaceAll('-', '').slice(-16)}`,
      name: 'Integration Test',
      status: 'ACTIVE',
    },
  });
  for (const [id, name] of [
    [ADA, 'ada'],
    [BEN, 'ben'],
    [ADMIN, 'admin'],
  ] as const) {
    await owner.user.create({
      data: {
        id,
        tenantId: TENANT,
        email: `${id}@integration.test`,
        emailNormalized: `${id}@integration.test`,
        displayName: name,
        status: 'ACTIVE',
        updatedAt: FIXED_NOW,
      },
    });
  }
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: AUTHOR_ROLE,
    key: 'AUTHOR',
    userIds: [ADA, BEN],
    permissions: [Permission.DOCUMENT_VIEW, Permission.DOCUMENT_CREATE, Permission.LIBRARY_VIEW],
    now: FIXED_NOW,
  });
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: ADMIN_ROLE,
    key: 'TENANT_ADMIN',
    userIds: [ADMIN],
    now: FIXED_NOW,
  });
  // The role that federation's mapping will provision to. Seeded like any other, so the assertion
  // is about the mapping rather than about role creation.
  await seedRoleGrant(owner, {
    tenantId: TENANT,
    roleId: uuidv7(),
    key: 'READER',
    userIds: [],
    permissions: [Permission.DOCUMENT_VIEW],
    now: FIXED_NOW,
  });

  unitOfWork = new PrismaUnitOfWork(sharedDatabase(appConfig, logger, APP_URL));
  databases = sharedDatabase(appConfig, logger, APP_URL);
  library = realDocumentLibrary({
    clock,
    unitOfWork,
    config: appConfig,
    registry: everyTenantRegistry(APP_URL),
    storageRoot: '/tmp',
    signingSecret: 'an-integration-suite-secret-of-at-least-32',
    antivirus: {
      scanner: 'unconfigured',
      scan: () => Promise.reject(new Error('AV_DRIVER is NONE')),
    },
    users: { get: () => Promise.resolve(null) } as never,
  });
  permissions = realPermissions({ clock, unitOfWork, config: appConfig });
  readAudit = library.readAudit;
  webhooks = realWebhooks({ clock, unitOfWork });
  apiClients = realApiClients({ clock, unitOfWork, databases });
  sinks = realAuditSink({
    clock,
    unitOfWork,
    settings: { [Settings.FEATURE_AUDIT_STREAMING.key]: true },
  });

  await seedTree();
}, 180_000);

afterAll(async () => {
  await owner?.$disconnect();
});

async function seedTree(): Promise<void> {
  const created = await asAdmin(() =>
    library.libraries.createLibrary({
      code: 'INT',
      name: 'Controlled',
      ownerScopeType: ScopeType.TENANT,
    }),
  );
  const open = await asAdmin(() =>
    library.libraries.createFolder({
      libraryId: created.id,
      parentId: created.rootFolderId,
      name: 'Open',
      inheritAcl: true,
    }),
  );
  const closed = await asAdmin(() =>
    library.libraries.createFolder({
      libraryId: created.id,
      parentId: created.rootFolderId,
      name: 'Closed',
      inheritAcl: true,
    }),
  );
  closedFolderId = closed.id;

  const confidentiality = await asAdmin(() =>
    library.configuration.createConfidentiality({
      code: 'INTERNAL',
      name: 'Internal',
      rank: 1,
      allowDownload: true,
      allowPrint: true,
      watermark: false,
      requireReason: false,
    }),
  );
  const rule = await asAdmin(() =>
    library.numbering.create({
      key: 'int',
      name: 'Integration',
      separator: '-',
      segments: [
        { kind: NumberSegmentKind.LITERAL, value: 'INT' },
        { kind: NumberSegmentKind.SEQUENCE, padding: 3 },
      ],
      resetScope: ['NEVER'],
      reserveOnSubmit: false,
      strictGapless: false,
    }),
  );
  const type = await asAdmin(() =>
    library.configuration.createDocumentType({
      code: 'PROC',
      name: 'Procedure',
      numberingRuleId: rule.id,
      defaultConfidentialityId: confidentiality.id,
      revisionLabelStyle: RevisionLabelStyle.NUMERIC,
      isActive: true,
      fields: [],
    }),
  );

  await seedDocument(open.id, type.id, confidentiality.id, 'Open procedure');
  await seedDocument(closed.id, type.id, confidentiality.id, 'Closed procedure');

  // Ben is denied on the closed folder, **through the service a request uses**. Seeding the entry
  // with the owner client would write past row-level security and prove nothing about what a
  // request sees — Phase 14's finding, and this suite follows it.
  await asAdmin(() =>
    permissions.permissions.replaceFor(folderScope(closedFolderId), [
      {
        subjectType: AclSubjectType.USER,
        subjectId: asId<AnyId>(BEN),
        permission: Permission.DOCUMENT_VIEW,
        effect: AclEffect.DENY,
      },
    ]),
  );
}

/**
 * A document row, written with the owner client.
 *
 * A *fixture*, standing for a record an author would have created beforehand — which is the same
 * reasoning `acl-seed.ts` gives for a role grant, and is exactly what it would be wrong to do for
 * an `acl_entry`. This suite writes none of those that way.
 */
async function seedDocument(
  folderId: string,
  documentTypeId: string,
  confidentialityId: string,
  title: string,
): Promise<void> {
  await owner.document.create({
    data: {
      id: uuidv7(),
      tenantId: TENANT,
      folderId,
      documentTypeId,
      confidentialityId,
      title,
      status: 'DRAFT',
      ownerUserId: ADMIN,
      updatedAt: FIXED_NOW,
    },
  });
}

// -----------------------------------------------------------------------------------------
// The phase's central safety property
// -----------------------------------------------------------------------------------------

describe('a machine token reaches exactly what its subject reaches', () => {
  let adaKey: string;
  let benKey: string;

  it('mints keys bound to two people, and returns each secret once', async () => {
    const forAda = await asAdmin(() =>
      apiClients.service.create({
        name: 'Ada’s integration',
        subjectUserId: ADA,
        scopes: [ApiScope.DOCUMENTS_READ],
      }),
    );
    const forBen = await asAdmin(() =>
      apiClients.service.create({
        name: 'Ben’s integration',
        subjectUserId: BEN,
        scopes: [ApiScope.DOCUMENTS_READ],
      }),
    );
    adaKey = forAda.secret;
    benKey = forBen.secret;

    expect(parseApiKey(adaKey)).not.toBeNull();
    // The stored row carries a *digest*, never the secret. A read path that returned one would be
    // a way to obtain a credential from a screen.
    const stored = await owner.apiClient.findUnique({ where: { id: forAda.client.id } });
    expect(stored?.secretHash).not.toContain(parseApiKey(adaKey)?.secret ?? 'x');
    expect(stored?.subjectUserId).toBe(ADA);
  });

  it('resolves a key to its subject, with the scope-narrowed permissions', async () => {
    const principal = await asNobody(() => apiClients.service.authenticate(TENANT, adaKey));
    expect(principal).not.toBeNull();
    // **`userId` is a person.** This is the assertion the whole design turns on: had it been null,
    // `visibilityCondition` would answer an empty predicate and the list below would be the whole
    // tenant.
    expect(principal?.subjectUserId).toBe(ADA);
    expect(principal?.permissions).toContain(Permission.DOCUMENT_VIEW);
    // `documents:read` does not admit `document:create`, which Ada holds. The intersection is
    // applied before anything downstream can see the subject's unfiltered set.
    expect(principal?.permissions).not.toContain(Permission.DOCUMENT_CREATE);
  });

  it('gives two keys different rows from the same list call — not an empty predicate', async () => {
    const ada = await asNobody(() => apiClients.service.authenticate(TENANT, adaKey));
    const ben = await asNobody(() => apiClients.service.authenticate(TENANT, benKey));

    const listAs = (principal: NonNullable<typeof ada>) =>
      runWithContext(
        {
          ...contextFor(principal.subjectUserId, principal.roleKeys),
          permissions: [...principal.permissions],
          channel: 'API',
          apiClientId: principal.apiClientId,
        },
        () => library.documents.list(listRequest),
      );

    const forAda = await listAs(ada!);
    const forBen = await listAs(ben!);

    expect(forAda.data.map((row) => row.title)).toContain('Closed procedure');
    // Ben's key sees strictly less, because Ben does. A subject-less machine principal would have
    // given both of them everything — including the folder Ben is explicitly denied.
    expect(forBen.data.map((row) => row.title)).not.toContain('Closed procedure');
    expect(forBen.meta.total).toBe(forAda.meta.total - 1);
    // And neither of them is the whole tenant: the empty-predicate failure would show here as a
    // total that matched an unfiltered count.
    expect(forAda.meta.total).toBe(2);
  });

  it('writes ActorChannel.API and the client id into the hash-chained trail', async () => {
    const principal = await asNobody(() => apiClients.service.authenticate(TENANT, adaKey));
    const machineContext: RequestContext = {
      ...contextFor(principal!.subjectUserId, principal!.roleKeys),
      permissions: [...principal!.permissions],
      channel: 'API',
      apiClientId: principal!.apiClientId,
    };
    // A read, which is what a machine caller mostly does. `open` — not `get` — is the audited one:
    // 13 §5 counts an explicit open rather than every row a list drew. It records through the
    // read-audit buffer, whose actor is built from the context, which is the change that made
    // `API` writable at all.
    const listed = await runWithContext(machineContext, () => library.documents.list(listRequest));
    await runWithContext(machineContext, () => library.documents.open(String(listed.data[0]!.id)));
    await readAudit.flush();

    const rows = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, channel: 'API' },
      orderBy: { sequence: 'desc' },
      take: 5,
    });
    // `API` has been in the `actor_channel` enum since Phase 0.5 and nothing had ever written it.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.apiClientId === principal!.apiClientId)).toBe(true);
    // Covered by chain version 3, so the credential that acted is attested rather than merely
    // recorded.
    expect(rows[0]?.chainHashVersion).toBe(3);
  });

  it('refuses a revoked key, a wrong secret and rubbish, all identically', async () => {
    const revoked = await asAdmin(() =>
      apiClients.service.create({
        name: 'To be revoked',
        subjectUserId: ADA,
        scopes: [ApiScope.DOCUMENTS_READ],
      }),
    );
    await asAdmin(() => apiClients.service.revoke(revoked.client.id, undefined));

    expect(
      await asNobody(() => apiClients.service.authenticate(TENANT, revoked.secret)),
    ).toBeNull();
    const parsed = parseApiKey(adaKey)!;
    const wrongSecret = `mdk.${parsed.prefix}.${'z'.repeat(43)}`;
    expect(await asNobody(() => apiClients.service.authenticate(TENANT, wrongSecret))).toBeNull();
    expect(await asNobody(() => apiClients.service.authenticate(TENANT, 'not-a-key'))).toBeNull();
  });

  it('stops working the moment its subject is disabled', async () => {
    const key = await asAdmin(() =>
      apiClients.service.create({
        name: 'Bound to Ben',
        subjectUserId: BEN,
        scopes: [ApiScope.DOCUMENTS_READ],
      }),
    );
    expect(
      await asNobody(() => apiClients.service.authenticate(TENANT, key.secret)),
    ).not.toBeNull();

    await owner.user.update({ where: { id: BEN }, data: { status: 'DISABLED' } });
    // The subject's eligibility is read at *authentication*, never copied onto the key when it was
    // minted — Phase 11's rule for delegation authority, applied to a credential. This is what
    // makes offboarding work.
    expect(await asNobody(() => apiClients.service.authenticate(TENANT, key.secret))).toBeNull();
    await owner.user.update({ where: { id: BEN }, data: { status: 'ACTIVE' } });
  });

  it('refuses a scope the catalogue does not know, and a client with none', async () => {
    await expect(
      asAdmin(() =>
        apiClients.service.create({
          name: 'Everything',
          subjectUserId: ADA,
          scopes: ['documents:everything'],
        }),
      ),
    ).rejects.toThrow();
    await expect(
      asAdmin(() => apiClients.service.create({ name: 'Nothing', subjectUserId: ADA, scopes: [] })),
    ).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------------------
// Webhooks
// -----------------------------------------------------------------------------------------

describe('a webhook is signed, and a receiver can verify it', () => {
  let endpointId: string;
  let secret: string;

  it('creates an endpoint and returns its signing key once', async () => {
    const created = await asAdmin(() =>
      webhooks.admin.create({
        name: 'Acme integration',
        url: 'https://hooks.example.com/edms',
        eventTypes: [],
        enabled: true,
      }),
    );
    endpointId = created.endpoint.id;
    secret = created.secret;
    expect(secret.length).toBeGreaterThanOrEqual(32);
    // The read path never returns it — the `select` is the enforcement, not a mapper's discipline.
    const read = await asAdmin(() => webhooks.admin.get(endpointId));
    expect(Object.keys(read)).not.toContain('secret');
  });

  it('delivers a signed envelope a receiver verifies from the documented scheme alone', async () => {
    const eventId = asId<AnyId>(uuidv7());
    const queued = await runWithContext(contextFor(null, []), () =>
      webhooks.delivery.fanOut({
        eventId,
        tenantId: TENANT,
        eventType: 'document.published',
        aggregateType: 'document',
        aggregateId: uuidv7(),
        occurredAt: FIXED_NOW,
        payload: { title: 'a title nobody should receive' },
        correlationId: 'webhook-suite',
      }),
    );
    expect(queued).toBe(1);

    const sent = webhooks.http.sent.at(-1)!;
    // **The receiver's half**, written from the scheme rather than by calling our own `createHmac`.
    expect(
      verifyWebhookSignature({
        secret,
        header: sent.headers[WEBHOOK_SIGNATURE_HEADER]!,
        timestamp: sent.headers[WEBHOOK_TIMESTAMP_HEADER]!,
        body: sent.body!,
        now: FIXED_NOW,
      }),
    ).toBe(true);

    // A wrong key, a tampered body and a stale timestamp each fail.
    expect(
      verifyWebhookSignature({
        secret: 'a'.repeat(64),
        header: sent.headers[WEBHOOK_SIGNATURE_HEADER]!,
        timestamp: sent.headers[WEBHOOK_TIMESTAMP_HEADER]!,
        body: sent.body!,
        now: FIXED_NOW,
      }),
    ).toBe(false);
    expect(
      verifyWebhookSignature({
        secret,
        header: sent.headers[WEBHOOK_SIGNATURE_HEADER]!,
        timestamp: sent.headers[WEBHOOK_TIMESTAMP_HEADER]!,
        body: `${sent.body!} `,
        now: FIXED_NOW,
      }),
    ).toBe(false);
    // The replay window. This is why the timestamp is *inside* the signed string rather than
    // beside it — a signature over an unchanged body would otherwise be valid for ever.
    expect(
      verifyWebhookSignature({
        secret,
        header: sent.headers[WEBHOOK_SIGNATURE_HEADER]!,
        timestamp: sent.headers[WEBHOOK_TIMESTAMP_HEADER]!,
        body: sent.body!,
        now: new Date(FIXED_NOW.getTime() + 3_600_000),
      }),
    ).toBe(false);
  });

  it('carries identity and never content', () => {
    const sent = webhooks.http.sent.at(-1)!;
    const envelope = JSON.parse(sent.body!) as Record<string, unknown>;
    expect(envelope['type']).toBe('document.published');
    expect(envelope['subject']).toMatchObject({ type: 'document' });
    // **The document's title is not in the payload.** An outbound webhook has no subject to
    // resolve reach against, so anything it carried would leave the tenant on the strength of a
    // URL somebody typed. The receiver calls back with its own credential and gets what that
    // credential may see.
    expect(sent.body).not.toContain('a title nobody should receive');
  });

  it('does not deliver an event the endpoint has not subscribed to', async () => {
    await asAdmin(() => webhooks.admin.update(endpointId, undefined, { eventTypes: ['workflow'] }));
    const before = webhooks.http.sent.length;
    await runWithContext(contextFor(null, []), () =>
      webhooks.delivery.fanOut({
        eventId: asId<AnyId>(uuidv7()),
        tenantId: TENANT,
        eventType: 'document.created',
        aggregateType: 'document',
        aggregateId: uuidv7(),
        occurredAt: FIXED_NOW,
        payload: {},
        correlationId: 'webhook-suite',
      }),
    );
    expect(webhooks.http.sent.length).toBe(before);
    await asAdmin(() => webhooks.admin.update(endpointId, undefined, { eventTypes: [] }));
  });

  it('sends once for an event redelivered by the outbox', async () => {
    const eventId = asId<AnyId>(uuidv7());
    const event = {
      eventId,
      tenantId: TENANT,
      eventType: 'document.published' as const,
      aggregateType: 'document',
      aggregateId: uuidv7(),
      occurredAt: FIXED_NOW,
      payload: {},
      correlationId: 'webhook-suite',
    };
    const first = await runWithContext(contextFor(null, []), () => webhooks.delivery.fanOut(event));
    const second = await runWithContext(contextFor(null, []), () =>
      webhooks.delivery.fanOut(event),
    );
    expect(first).toBe(1);
    // At-least-once from the outbox must not become two POSTs to somebody else's server. The
    // unique `(endpoint_id, event_id)` is what makes the second arrival a no-op.
    expect(second).toBe(0);
  });
});

describe('a webhook is retried and dead-lettered without losing the event', () => {
  let endpointId: string;

  it('retries a failing delivery and keeps its payload', async () => {
    const created = await asAdmin(() =>
      webhooks.admin.create({
        name: 'A receiver having a bad day',
        url: 'https://hooks.example.com/failing',
        eventTypes: ['retention'],
        enabled: true,
      }),
    );
    endpointId = created.endpoint.id;

    webhooks.http.status = 500;
    const eventId = asId<AnyId>(uuidv7());
    await runWithContext(contextFor(null, []), () =>
      webhooks.delivery.fanOut({
        eventId,
        tenantId: TENANT,
        eventType: 'retention.due',
        aggregateType: 'retention',
        aggregateId: uuidv7(),
        occurredAt: FIXED_NOW,
        payload: {},
        correlationId: 'webhook-suite',
      }),
    );

    const row = await owner.webhookDelivery.findFirst({
      where: { tenantId: TENANT, eventId },
    });
    expect(row?.state).toBe('RETRYING');
    expect(row?.attempts).toBe(1);
    expect(row?.responseStatus).toBe(500);
    // The payload survives, which is the whole point: a replay a week later must not depend on the
    // outbox row still existing or on the rendering being unchanged since.
    expect(row?.payload).toContain('retention.due');
    expect(row?.nextAttemptAt).not.toBeNull();
  });

  it('dead-letters after the configured attempts, and stops re-attempting', async () => {
    // Its own stack, because the attempt count is a *setting* and the assertion is about reaching
    // it — two attempts rather than the default eight, so the test is a test and not a wait.
    const impatient = realWebhooks({
      clock,
      unitOfWork,
      settings: { [Settings.WEBHOOK_MAX_ATTEMPTS.key]: 2 },
      http: webhooks.http,
    });
    const eventId = asId<AnyId>(uuidv7());
    await runWithContext(contextFor(null, []), () =>
      impatient.delivery.fanOut({
        eventId,
        tenantId: TENANT,
        eventType: 'retention.due',
        aggregateType: 'retention',
        aggregateId: uuidv7(),
        occurredAt: FIXED_NOW,
        payload: {},
        correlationId: 'webhook-suite',
      }),
    );
    // The first attempt failed inside `fanOut`; the sweep makes the second, which is the last.
    await runWithContext(contextFor(null, []), () =>
      impatient.delivery.retryDue(new Date(FIXED_NOW.getTime() + 3_600_000)),
    );

    const row = await owner.webhookDelivery.findFirst({ where: { tenantId: TENANT, eventId } });
    expect(row?.state).toBe('DEAD');
    // 18 §8's "never silently dropped", applied to a system recipient: the row and its bytes are
    // still here, which is what makes a manual replay possible.
    expect(row?.payload).toContain('retention.due');
    // Null, so the sweep never picks it up again.
    expect(row?.nextAttemptAt).toBeNull();

    const before = webhooks.http.sent.length;
    await runWithContext(contextFor(null, []), () =>
      impatient.delivery.retryDue(new Date(FIXED_NOW.getTime() + 7_200_000)),
    );
    expect(webhooks.http.sent.length).toBe(before);
  });

  it('disables an endpoint that has been refusing long enough, and re-enabling clears the count', async () => {
    await owner.webhookEndpoint.update({
      where: { id: endpointId },
      data: { failureCount: 19 },
    });
    const eventId = asId<AnyId>(uuidv7());
    await runWithContext(contextFor(null, []), () =>
      webhooks.delivery.fanOut({
        eventId,
        tenantId: TENANT,
        eventType: 'retention.due',
        aggregateType: 'retention',
        aggregateId: uuidv7(),
        occurredAt: FIXED_NOW,
        payload: {},
        correlationId: 'webhook-suite',
      }),
    );
    const disabled = await owner.webhookEndpoint.findUnique({ where: { id: endpointId } });
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.disabledReason).toContain('consecutive failures');

    // Re-enabling clears the counter as well. An endpoint whose receiver has been fixed and which
    // came back with nineteen failures still on it would disable itself again on the next hiccup.
    await asAdmin(() => webhooks.admin.update(endpointId, undefined, { enabled: true }));
    const revived = await owner.webhookEndpoint.findUnique({ where: { id: endpointId } });
    expect(revived?.failureCount).toBe(0);
    expect(revived?.disabledAt).toBeNull();

    webhooks.http.status = 200;
  });

  it('records a success and resets the run of failures', async () => {
    await runWithContext(contextFor(null, []), () =>
      webhooks.delivery.fanOut({
        eventId: asId<AnyId>(uuidv7()),
        tenantId: TENANT,
        eventType: 'retention.due',
        aggregateType: 'retention',
        aggregateId: uuidv7(),
        occurredAt: FIXED_NOW,
        payload: {},
        correlationId: 'webhook-suite',
      }),
    );
    const endpoint = await owner.webhookEndpoint.findUnique({ where: { id: endpointId } });
    expect(endpoint?.failureCount).toBe(0);
    expect(endpoint?.lastSuccessAt).not.toBeNull();
  });
});

// -----------------------------------------------------------------------------------------
// The outbound boundary — against the real adapter
// -----------------------------------------------------------------------------------------

describe('an outbound URL is refused when it is not on the allow-list', () => {
  /** A resolver the suite steers, so the address checks are exercised without a network. */
  const answers = new Map<string, readonly string[]>([
    ['hooks.example.com', ['93.184.216.34']],
    ['siem.collectors.example.net', ['93.184.216.35']],
    ['rebind.example.com', ['127.0.0.1']],
    ['split.example.com', ['93.184.216.36', '10.0.0.5']],
  ]);
  // The **real** adapter with a real allow-list, composed in the testing layer because a suite
  // here may not import `infrastructure/`. Only the network is stubbed — a fake allow-list would
  // let this prove a refusal the real class never made.
  const adapter = realOutboundHttp({
    allowList: [
      'hooks.example.com',
      '.collectors.example.net',
      'rebind.example.com',
      'split.example.com',
    ],
    resolve: (host) => Promise.resolve(answers.get(host) ?? []),
  });

  it('permits a host on the list', async () => {
    expect(await adapter.permits('https://hooks.example.com/edms')).toEqual({
      allowed: true,
      reason: null,
    });
    // A leading dot covers subdomains.
    expect((await adapter.permits('https://siem.collectors.example.net/in')).allowed).toBe(true);
  });

  it('refuses a host that is not on it', async () => {
    const verdict = await adapter.permits('https://evil.example.org/steal');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('allow-list');
  });

  it('refuses a lookalike that a suffix match would let through', async () => {
    // `hooks.example.com.evil.net` ends with nothing on the list under a boundary-aware match, and
    // would pass a naive `endsWith`.
    expect((await adapter.permits('https://hooks.example.com.evil.net/x')).allowed).toBe(false);
  });

  it('refuses a permitted host that resolves to a private address', async () => {
    // The DNS-rebinding case, and the reason an allow-list of *names* alone is not a control.
    const verdict = await adapter.permits('https://rebind.example.com/x');
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).not.toContain('127.0.0.1');
  });

  it('refuses a host that resolves to one public and one private address', async () => {
    // Every answer is checked, not the first: picking whichever came back first is a coin toss.
    expect((await adapter.permits('https://split.example.com/x')).allowed).toBe(false);
  });

  it('refuses http, and a URL carrying credentials', async () => {
    expect((await adapter.permits('http://hooks.example.com/x')).allowed).toBe(false);
    expect((await adapter.permits('https://u:p@hooks.example.com/x')).allowed).toBe(false);
    expect((await adapter.permits('file:///etc/passwd')).allowed).toBe(false);
    expect((await adapter.permits('not a url')).allowed).toBe(false);
  });

  it('opens no socket for a refusal', async () => {
    // The fetch above rejects if it is ever called. A `REFUSED` that reached it would fail here.
    const result = await adapter.send({
      url: 'https://evil.example.org/steal',
      method: 'POST',
      body: '{}',
      timeoutMs: 1_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('REFUSED');
    }
  });

  it('knows the ranges an internal service could be on', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.0.1',
      '192.168.1.1',
      // The cloud metadata service — the single most valuable target an SSRF has.
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      // IPv4-mapped IPv6: the same address wearing a different notation.
      '::ffff:127.0.0.1',
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress('93.184.216.34')).toBe(true);
    expect(isPublicAddress('2606:2800:220:1::1')).toBe(true);
  });

  it('refuses an endpoint whose URL this deployment would never reach, at save time', async () => {
    // The check belongs at the moment somebody presses the button, not in a delivery log an hour
    // later. `WebhookAdminService` asks `permits()`, which makes no request.
    const strict = realWebhooks({ clock, unitOfWork, http: new RecordingHttp() });
    strict.http.fail = 'REFUSED';
    await expect(
      asAdmin(() =>
        strict.admin.create({
          name: 'Somewhere we will not go',
          url: 'https://internal.example.org/x',
          eventTypes: [],
          enabled: true,
        }),
      ),
    ).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------------------
// Federation
// -----------------------------------------------------------------------------------------

describe('an SSO sign-in provisions to pre-mapped roles and no further', () => {
  it('creates the person the mapping describes, with exactly the mapped roles', async () => {
    const users = realFederatedUsers();
    const providerId = asId<AnyId>(uuidv7());
    await owner.identityProvider.create({
      data: {
        id: providerId,
        tenantId: TENANT,
        name: 'Acme Entra',
        issuer: 'https://login.microsoftonline.com/acme/v2.0',
        discoveryUrl:
          'https://login.microsoftonline.com/acme/v2.0/.well-known/openid-configuration',
        clientId: 'client-abc',
        clientSecret: 'a-secret',
        domains: ['acme.test'],
        defaultRoleKeys: [],
        updatedAt: FIXED_NOW,
      },
    });

    const userId = asId<UserId>(uuidv7());
    await asNobody(() =>
      unitOfWork.run(() =>
        users.provision({
          id: userId,
          email: 'grace@acme.test',
          emailNormalized: 'grace@acme.test',
          displayName: 'Grace Hopper',
          providerId,
          externalId: 'entra-subject-1',
          // What `rolesForClaims` produced: the mapped group, plus one key that matches no role in
          // this tenant.
          roleKeys: ['READER', 'A_ROLE_THAT_DOES_NOT_EXIST'],
          at: FIXED_NOW,
        }),
      ),
    );

    const created = await owner.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    expect(created?.identitySource).toBe('FEDERATED');
    expect(created?.externalId).toBe('entra-subject-1');
    // No password hash, which is the distinction the product could not make before this phase:
    // "no password because they federate" against "no password because the invitation is open".
    expect(created?.passwordHash).toBeNull();
    expect(created?.status).toBe('ACTIVE');
    // **Exactly the mapping, and nothing more.** The unmapped key granted nothing and, crucially,
    // did not bring a role into existence — a provider that could do that would decide this
    // tenant's permission model.
    expect(created?.roles.map((assignment) => assignment.role.key)).toEqual(['READER']);
    expect(
      await owner.role.count({ where: { tenantId: TENANT, key: 'A_ROLE_THAT_DOES_NOT_EXIST' } }),
    ).toBe(0);
  });

  it('matches a returning signer by subject first, and binds an existing account by address', async () => {
    const users = realFederatedUsers();
    const provider = await owner.identityProvider.findFirst({ where: { tenantId: TENANT } });
    const providerId = asId<AnyId>(provider!.id);

    // By subject: the person who changed their address at the provider is the same person, and a
    // match on address alone would have provisioned a second account.
    await owner.user.update({
      where: { id: (await owner.user.findFirst({ where: { externalId: 'entra-subject-1' } }))!.id },
      data: { email: 'grace.hopper@acme.test', emailNormalized: 'grace.hopper@acme.test' },
    });
    const bySubject = await asNobody(() =>
      unitOfWork.run(() =>
        users.findByExternalIdentity(providerId, 'entra-subject-1', 'somebody.else@acme.test'),
      ),
    );
    expect(bySubject).not.toBeNull();

    // By address, once: this is how a tenant switching federation on binds its existing accounts
    // rather than duplicating all of them.
    const local = await asNobody(() =>
      unitOfWork.run(() =>
        users.findByExternalIdentity(providerId, 'entra-subject-2', `${ADA}@integration.test`),
      ),
    );
    expect(local).toBe(ADA);

    // And an account already bound to *another* provider subject is not claimable by address —
    // which is what stops a second person at the same provider taking the first one's account.
    const claimed = await asNobody(() =>
      unitOfWork.run(() =>
        users.findByExternalIdentity(providerId, 'entra-subject-3', 'grace.hopper@acme.test'),
      ),
    );
    expect(claimed).toBeNull();
  });
});

// -----------------------------------------------------------------------------------------
// The audit stream
// -----------------------------------------------------------------------------------------

describe('the audit stream is a gap-free cursor', () => {
  it('pages by sequence and resumes exactly where it left off', async () => {
    const first = await asAdmin(() => sinks.service.page(0n, 5));
    expect(first.events.length).toBeGreaterThan(0);
    // Contiguous by sequence, which is the completeness guarantee the integration exists for: a
    // consumer receiving N+2 after N *knows* it missed one.
    const sequences = first.events.map((event) => BigInt(event.sequence));
    for (let index = 1; index < sequences.length; index += 1) {
      expect(sequences[index]! - sequences[index - 1]!).toBe(1n);
    }
    // Every row carries its digest and the field set that digest covers, so a collector can verify
    // the chain it stored without asking us again.
    expect(first.events[0]?.hash).toHaveLength(64);
    expect(first.events[0]?.chainHashVersion).toBeGreaterThanOrEqual(1);

    const second = await asAdmin(() => sinks.service.page(first.cursor, 5));
    expect(second.events.every((event) => BigInt(event.sequence) > first.cursor)).toBe(true);
  });

  it('refuses when the tenant has not turned streaming on', async () => {
    // 13 §6 calls the sink optional per tenant, and a tenant that has not turned it on has not
    // agreed to its trail being polled. `403` rather than `404`: the caller holds the permission
    // and the surface exists, which is what 15 §4 distinguishes the two by.
    const off = realAuditSink({
      clock,
      unitOfWork,
      settings: { [Settings.FEATURE_AUDIT_STREAMING.key]: false },
    });
    await expect(asAdmin(() => off.service.page(0n, 5))).rejects.toThrow();
  });

  it('pushes a signed batch and advances the cursor only on success', async () => {
    await asAdmin(() =>
      sinks.service.upsert({
        kind: 'PUSH',
        name: 'Acme SIEM',
        endpointUrl: 'https://siem.collectors.example.net/in',
        actions: [],
        enabled: true,
      }),
    );

    sinks.http.status = 500;
    const failed = await asAdmin(() => sinks.service.push());
    expect(failed.sent).toBe(0);
    const afterFailure = await owner.auditSink.findFirst({ where: { tenantId: TENANT } });
    // The cursor did not move. Advancing first and posting second would lose a range on any
    // failure, with no way to discover which range was lost.
    expect(afterFailure?.lastStreamedSequence).toBe(0n);
    expect(afterFailure?.lastError).toContain('500');

    sinks.http.status = 200;
    const sent = await asAdmin(() => sinks.service.push());
    expect(sent.sent).toBeGreaterThan(0);
    const afterSuccess = await owner.auditSink.findFirst({ where: { tenantId: TENANT } });
    expect(afterSuccess?.lastStreamedSequence).toBeGreaterThan(0n);
    expect(afterSuccess?.lastError).toBeNull();

    // The batch is signed with the same construction a webhook uses, so one receiver
    // implementation verifies both.
    const posted = sinks.http.sent.at(-1)!;
    expect(posted.headers[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^v1=/);
  });

  it('refuses a push sink with no URL, and a pull sink with one', async () => {
    await expect(
      asAdmin(() =>
        sinks.service.upsert({ kind: 'PUSH', name: 'No URL', actions: [], enabled: true }),
      ),
    ).rejects.toThrow();
    await expect(
      asAdmin(() =>
        sinks.service.upsert({
          kind: 'PULL',
          name: 'A URL nobody posts to',
          endpointUrl: 'https://siem.collectors.example.net/in',
          actions: [],
          enabled: true,
        }),
      ),
    ).rejects.toThrow();
  });
});

/**
 * One delivery row is attempted once, however many workers meet it — Slice 51.
 *
 * `claimDue` is named for what it is meant to do and does not do it: it is a `findMany` over
 * `state IN (PENDING, RETRYING) AND next_attempt_at <= now`, marking nothing. `fanOut` writes each
 * row `nextAttemptAt: now` and then attempts it *outside* the transaction, so from the moment it
 * commits until it settles the row is both in flight and due — and `webhooks.retry-due` runs every
 * minute onto a lane whose per-tenant concurrency is four.
 *
 * The service states the invariant this breaks: "this event has already been recorded for this
 * endpoint, so the second arrival must not become a second POST."
 */
describe('one delivery, one POST, however many workers meet it', () => {
  let endpointId: string;

  async function anEndpoint(): Promise<string> {
    const created = await asAdmin(() =>
      webhooks.admin.create({
        name: `Sweep ${uuidv7().slice(0, 8)}`,
        url: `https://hooks.example.com/sweep-${uuidv7().slice(0, 8)}`,
        eventTypes: [],
        enabled: true,
      }),
    );
    return created.endpoint.id;
  }

  function anEvent() {
    return {
      eventId: asId<AnyId>(uuidv7()),
      tenantId: TENANT,
      eventType: 'document.published',
      aggregateType: 'document',
      aggregateId: uuidv7(),
      occurredAt: FIXED_NOW,
      payload: { marker: 'sweep' },
      correlationId: 'sweep-suite',
    };
  }

  const postsTo = (url: string): number =>
    webhooks.http.sent.filter((sent) => sent.url === url).length;

  function urlOf(id: string): Promise<string> {
    return asAdmin(async () => (await webhooks.admin.get(id)).url);
  }

  beforeAll(async () => {
    endpointId = await anEndpoint();
  });

  it('posts once for one event when nothing else is sweeping', async () => {
    const url = await urlOf(endpointId);
    const before = postsTo(url);

    await runWithContext(contextFor(null, []), () => webhooks.delivery.fanOut(anEvent()));

    expect(postsTo(url) - before).toBe(1);
  });

  it('posts again when the endpoint refused and the sweep finds it due', async () => {
    const url = await urlOf(endpointId);
    const before = postsTo(url);
    webhooks.http.status = 500;
    await runWithContext(contextFor(null, []), () => webhooks.delivery.fanOut(anEvent()));
    webhooks.http.status = 200;

    // The sweep must still deliver what is genuinely due — a claim that refused everything would
    // pass the race assertion below while breaking retries altogether.
    await runWithContext(contextFor(null, []), () =>
      webhooks.delivery.retryDue(new Date(FIXED_NOW.getTime() + 60 * 60 * 1000)),
    );

    expect(postsTo(url) - before).toBe(2);
  });

  it('posts once when the retry sweep meets a delivery already in flight', async () => {
    // Its own endpoint, so nothing another case left RETRYING can be swept into this count.
    const isolated = await anEndpoint();
    const url = await urlOf(isolated);
    const before = postsTo(url);

    /*
     * The seam: the real HTTP port, held on its first send. `fanOut` has committed the delivery
     * row by then — `nextAttemptAt: now`, state PENDING — so the sweep that runs while it is held
     * sees exactly what a sweep running in the same minute sees in production.
     */
    let admit: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let held = false;
    const realSend = webhooks.http.send.bind(webhooks.http);
    webhooks.http.send = async (request: Parameters<typeof realSend>[0]) => {
      if (!held) {
        held = true;
        await inFlight;
      }
      return realSend(request);
    };

    try {
      const fanning = runWithContext(contextFor(null, []), () =>
        webhooks.delivery.fanOut(anEvent()),
      );
      // A second later — inside the attempt's own ten-second timeout, which is the window in
      // which the first send is genuinely still outstanding. The lane carries fan-out jobs and
      // retry jobs together at four per tenant, so a sweep starting here is ordinary.
      await runWithContext(contextFor(null, []), () =>
        webhooks.delivery.retryDue(new Date(FIXED_NOW.getTime() + 1_000)),
      );
      admit();
      await fanning;
    } finally {
      webhooks.http.send = realSend;
    }

    // The delivery's own row is the unambiguous record of how many times the product attempted
    // it, and it is what `maxAttempts` and the endpoint's consecutive-failure disable are counted
    // from. One row, attempted once: a second attempt is a duplicate POST the receiver never asked
    // for, and it spends the endpoint's failure budget twice as fast.
    const rows = await owner.webhookDelivery.findMany({
      where: { endpointId: isolated },
      select: { state: true, attempts: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempts).toBe(1);
    expect(postsTo(url)).toBeGreaterThan(before);
  });

  it('posts once when two sweeps select the same due delivery together', async () => {
    const isolated = await anEndpoint();

    // A delivery genuinely due: the endpoint refused, so the row is RETRYING with a backoff.
    webhooks.http.status = 500;
    await runWithContext(contextFor(null, []), () => webhooks.delivery.fanOut(anEvent()));
    webhooks.http.status = 200;
    const settled = await owner.webhookDelivery.findFirstOrThrow({
      where: { endpointId: isolated },
      select: { attempts: true, nextAttemptAt: true },
    });
    const due = new Date((settled.nextAttemptAt ?? FIXED_NOW).getTime() + 1_000);

    /*
     * Two sweeps at the same instant. Both `claimDue` selections are issued before either attempt
     * begins, so both hold the same row — which is the case the claim's own due predicate decides:
     * the first attempt leases the row forward, and the second finds it no longer due. Nothing
     * here depends on which sweep the scheduler resumes first; either order gives one attempt.
     */
    await Promise.all([
      runWithContext(contextFor(null, []), () => webhooks.delivery.retryDue(due)),
      runWithContext(contextFor(null, []), () => webhooks.delivery.retryDue(due)),
    ]);

    const after = await owner.webhookDelivery.findFirstOrThrow({
      where: { endpointId: isolated },
      select: { attempts: true },
    });
    expect(after.attempts).toBe(settled.attempts + 1);
  });
});

/**
 * Two callers, each parked at a chosen boundary.
 *
 * Gated on an explicit marker rather than on "the turnstile is armed", so the ordinary setup this
 * suite performs through the same repository does not park itself, take ordinals no slot was armed
 * for, and leave the caller it does want to hold waiting for ever.
 */
class Turnstile<TMarker> {
  readonly arrivals: TMarker[] = [];
  readonly reached: Promise<void>[] = [];
  private readonly announce: (() => void)[] = [];
  private readonly admissions: Promise<void>[] = [];
  private readonly admits: (() => void)[] = [];

  arm(callers: number): number {
    const base = this.reached.length;
    for (let index = 0; index < callers; index += 1) {
      let arrive: () => void = () => undefined;
      this.reached.push(
        new Promise<void>((resolve) => {
          arrive = resolve;
        }),
      );
      this.announce.push(arrive);
      let admit: () => void = () => undefined;
      this.admissions.push(
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
      );
      this.admits.push(admit);
    }
    return base;
  }

  async park(marker: TMarker): Promise<void> {
    const ordinal = this.arrivals.length;
    this.arrivals.push(marker);
    this.announce[ordinal]?.();
    await this.admissions[ordinal];
  }

  release(ordinal: number): void {
    this.admits[ordinal]?.();
  }
}

/**
 * Revoking one key twice, at once — Slice 70.
 *
 * `revoke` is deliberately idempotent: "revoking a revoked key is the outcome the caller wanted",
 * so the second of two *ordered* callers reads `revokedAt` already set and is answered with the
 * row. That is the intended behaviour, and this suite already relies on it.
 *
 * Two callers at once both read `revokedAt` as null, so both pass that check and both reach the
 * write. The write carries the version in its `where` — the optimistic lock every aggregate here
 * carries — but it is `update`, not the `updateMany` + affected-row count the rest of the product
 * uses, so the loser does not match its row and Prisma raises `P2025`. Nothing translates it: the
 * filter maps `DomainError` and `HttpException` and calls everything else `INTERNAL`, so the loser
 * receives a **500** where the ordered caller receives its row.
 *
 * Both callers are held at the write until each has been shown to have read the live key, which is
 * what makes this the race and not a sequence.
 */
describe('one key, revoked twice at once', () => {
  const turnstile = new Turnstile<string>();
  /** Which revocation this test wants to stop at, and nothing else stops. */
  let parkOn: string | null = null;

  class ParkingApiClientRepository extends PrismaApiClientRepository {
    override async revoke(
      id: Parameters<PrismaApiClientRepository['revoke']>[0],
      at: Parameters<PrismaApiClientRepository['revoke']>[1],
      by: Parameters<PrismaApiClientRepository['revoke']>[2],
      expectedVersion: Parameters<PrismaApiClientRepository['revoke']>[3],
    ): ReturnType<PrismaApiClientRepository['revoke']> {
      // Parked *here*: the service has already read the key and found it live, and has written
      // nothing. That is the window the read is stale in.
      if (parkOn === `revoke:${String(id)}`) {
        await turnstile.park(`revoke:${String(id)}`);
      }
      return super.revoke(id, at, by, expectedVersion);
    }
  }

  /** The real stack, composed around a repository that only adds a place to stand. */
  let parking: ApiClientStack['service'];
  beforeAll(() => {
    parking = realApiClients({
      clock,
      unitOfWork,
      databases,
      repository: new ParkingApiClientRepository(databases),
    }).service;
  });

  async function aKey(name: string): Promise<{ id: string; version: number }> {
    const minted = await asAdmin(() =>
      parking.create({ name, subjectUserId: ADA, scopes: [ApiScope.DOCUMENTS_READ] }),
    );
    return { id: minted.client.id, version: minted.client.version };
  }

  it('revokes when nothing contends, and again idempotently', async () => {
    // The control, and the sequential answer the race must match. Without it every assertion below
    // passes on a service that revokes nothing.
    const key = await aKey('Solo revocation');
    const first = await asAdmin(() => parking.revoke(key.id, undefined));
    expect(first.revokedAt).not.toBeNull();

    // The ordered second caller: idempotent, answered with the row rather than refused.
    const second = await asAdmin(() => parking.revoke(key.id, undefined));
    expect(second.revokedAt).not.toBeNull();
    expect(second.id).toBe(key.id);
  });

  it('answers the loser the way the ordered second caller is answered', async () => {
    const key = await aKey('Contended revocation');
    parkOn = `revoke:${key.id}`;
    const base = turnstile.arm(2);

    // Each from its own scope, so each opens its own transaction. Both reach the write only after
    // their own read answered "live", which is what parking here proves.
    const one = asAdmin(() => parking.revoke(key.id, undefined));
    await turnstile.reached[base];
    const two = asAdmin(() => parking.revoke(key.id, undefined));
    await turnstile.reached[base + 1];
    expect(turnstile.arrivals.slice(-2)).toEqual([`revoke:${key.id}`, `revoke:${key.id}`]);

    turnstile.release(base);
    const winner = await one.then(
      (value) => ({ kind: 'revoked' as const, value, error: undefined }),
      (error: unknown) => ({ kind: 'failed' as const, value: undefined, error }),
    );
    turnstile.release(base + 1);
    const loser = await two.then(
      (value) => ({ kind: 'revoked' as const, value, error: undefined }),
      (error: unknown) => ({ kind: 'failed' as const, value: undefined, error }),
    );

    expect(winner.kind).toBe('revoked');
    expect(loser.kind).toBe('revoked');
    expect(loser.value?.revokedAt).not.toBeNull();
    expect(loser.value?.id).toBe(key.id);
    // The key is revoked once, by one of them, and stays revoked.
    const row = await owner.apiClient.findUniqueOrThrow({
      where: { id: key.id },
      select: { revokedAt: true, version: true },
    });
    expect(row.revokedAt).not.toBeNull();
    // Moved once, not twice: only the winner's write landed.
    expect(row.version).toBe(key.version + 1);

    /*
     * And the trail says so. Answering the loser with the row is only half the behaviour; the other
     * half is that it does not *claim the revocation*. Exactly one of the two records the act, and
     * the other records meeting a key already revoked — which is what the ordered second caller
     * records, and the only thing that distinguishes "I revoked it" from "it was revoked".
     */
    const trail = await owner.auditEvent.findMany({
      where: { tenantId: TENANT, action: 'API_CLIENT_REVOKED', subjectId: key.id },
      orderBy: { sequence: 'asc' },
    });
    expect(trail).toHaveLength(2);
    const claiming = trail.filter(
      (entry) =>
        (entry.payload as { after?: { alreadyRevoked?: boolean } })?.after?.alreadyRevoked !== true,
    );
    expect(claiming).toHaveLength(1);
  });
});
