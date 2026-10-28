import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AsymmetricSigner } from '@munaxa/crypto';
import { armorLicense, issueLicense, type EntitlementSnapshot } from '@munaxa/licensing';
import { afterAll, describe, expect, it } from 'vitest';

import { DocsFeature } from '@edms/domain';

import { aRequestContext } from '../../testing/factories';
import { FakeClock } from '../../testing/fake-ports';
import { MemoryEntitlementStateStore, entitlementsWith } from '../../testing/licensing';
import type { OutboundHttpPort, OutboundResult } from '../../ports/outbound-http.port';
import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { SubscriptionRequiredError } from '../errors/application-errors';
import { runWithContext } from '../tenancy/tenant-context';
import { ControlPlaneLookup } from './control-plane.lookup';
import { EntitlementGuard } from './entitlement.guard';
import { LicenseFileLookup } from './license-file.lookup';
import { LICENSED_OPERATION, REQUIRED_FEATURE } from './licensed.decorator';
import type { EntitlementLookup, EntitlementLookupResult } from './licensing.ports';
import { UnmeteredLookup } from './unmetered.lookup';

const TENANT = '019489f0-0000-7000-8000-000000000001';

function snapshot(overrides: Partial<EntitlementSnapshot> = {}): EntitlementSnapshot {
  return {
    schemaVersion: 1,
    customerId: 'cus_1',
    tenantId: TENANT,
    product: 'docs',
    deployment: 'SAAS',
    subscriptionId: 'sub_1',
    plan: { code: 'business', version: 3 },
    status: 'ACTIVE',
    trialEndsAt: null,
    expiresAt: '2026-06-01T00:00:00.000Z',
    graceUntil: '2026-06-15T00:00:00.000Z',
    features: [DocsFeature.WEBHOOKS],
    limits: { users: 5, 'storage.bytes': 1000 },
    resolvedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A lookup that answers whatever the test last told it to. */
class ScriptedLookup implements EntitlementLookup {
  readonly source = 'CONTROL_PLANE' as const;
  readonly cachesSnapshots = true;
  calls = 0;
  constructor(public answer: EntitlementLookupResult) {}
  lookup(): Promise<EntitlementLookupResult> {
    this.calls += 1;
    return Promise.resolve(this.answer);
  }
}

describe('EntitlementService', () => {
  it('the unmetered plan includes every feature and limits nothing, without touching the store', async () => {
    const store = new MemoryEntitlementStateStore();
    const service = entitlementsWith({ lookup: new UnmeteredLookup('SAAS'), store });
    const decision = await service.decide(TENANT, 'GROWTH', [DocsFeature.API_ACCESS]);
    expect(decision.allowed).toBe(true);
    expect(store.rows.size).toBe(0);
  });

  it('a live snapshot is stored for an outage, and reused within the refresh window', async () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const lookup = new ScriptedLookup({ kind: 'SNAPSHOT', snapshot: snapshot() });
    const store = new MemoryEntitlementStateStore();
    const service = entitlementsWith({ lookup, store, clock, refreshSeconds: 60 });
    await service.resolve(TENANT);
    await service.resolve(TENANT);
    expect(lookup.calls).toBe(1);
    expect(store.rows.get(TENANT)?.snapshot?.plan.code).toBe('business');
  });

  it('an outage degrades the stored snapshot by age and never widens it', async () => {
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const lookup = new ScriptedLookup({ kind: 'SNAPSHOT', snapshot: snapshot() });
    const service = entitlementsWith({ lookup, clock, refreshSeconds: 10 });
    await service.resolve(TENANT);

    lookup.answer = { kind: 'UNAVAILABLE', reason: 'CONTROL_PLANE_TIMEOUT' };
    clock.advanceBy(2 * 60 * 60 * 1000);
    const stale = await service.resolve(TENANT);
    expect(stale).toMatchObject({ source: 'STALE', cap: 'NO_GROWTH' });
    expect((await service.decide(TENANT, 'WRITE')).allowed).toBe(true);
    expect((await service.decide(TENANT, 'GROWTH')).allowed).toBe(false);
  });

  it('with nothing ever verified, an outage grants nothing — not even reads', async () => {
    const service = entitlementsWith({
      lookup: new ScriptedLookup({ kind: 'UNAVAILABLE', reason: 'CONTROL_PLANE_NETWORK' }),
    });
    expect(await service.decide(TENANT, 'READ')).toMatchObject({
      allowed: false,
      reason: 'NO_SUBSCRIPTION',
    });
  });

  it('an authoritative "no subscription" clears the stored snapshot so it cannot bridge a later outage', async () => {
    const lookup = new ScriptedLookup({ kind: 'SNAPSHOT', snapshot: snapshot() });
    const store = new MemoryEntitlementStateStore();
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const service = entitlementsWith({ lookup, store, clock, refreshSeconds: 10 });
    await service.resolve(TENANT);
    lookup.answer = { kind: 'NONE', reason: 'CONTROL_PLANE_NO_SUBSCRIPTION' };
    clock.advanceBy(20_000);
    await service.resolve(TENANT);
    expect(store.rows.get(TENANT)?.snapshot).toBeNull();
    lookup.answer = { kind: 'UNAVAILABLE', reason: 'CONTROL_PLANE_TIMEOUT' };
    clock.advanceBy(20_000);
    expect((await service.decide(TENANT, 'READ')).allowed).toBe(false);
  });

  it('decides at the latest observed instant, so a clock wound back cannot un-expire a term', async () => {
    const store = new MemoryEntitlementStateStore();
    await store.write(TENANT, {
      snapshot: null,
      source: 'CONTROL_PLANE',
      observedAt: new Date('2026-07-01T00:00:00Z'),
    });
    const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
    const lookup = new ScriptedLookup({ kind: 'SNAPSHOT', snapshot: snapshot() });
    const service = entitlementsWith({ lookup, store, clock });
    expect(await service.decide(TENANT, 'WRITE')).toMatchObject({
      allowed: false,
      status: 'EXPIRED',
    });
  });

  it('refuses a feature the plan does not include with 402, naming the reason', async () => {
    const service = entitlementsWith({
      lookup: new ScriptedLookup({ kind: 'SNAPSHOT', snapshot: snapshot() }),
      clock: new FakeClock(new Date('2026-01-01T00:00:00Z')),
    });
    await runWithContext(aRequestContext({ tenantId: TENANT as never }), async () => {
      await expect(service.require('READ', [DocsFeature.WEBHOOKS])).resolves.toBeUndefined();
      const refusal = service.require('READ', [DocsFeature.ESIGNATURE]);
      await expect(refusal).rejects.toBeInstanceOf(SubscriptionRequiredError);
      await expect(refusal).rejects.toMatchObject({
        code: 'SUBSCRIPTION_REQUIRED',
        details: { reason: 'FEATURE_NOT_INCLUDED' },
      });
    });
  });

  it('an unlimited ceiling enforces without a lock or a count', async () => {
    const service = entitlementsWith({ lookup: new UnmeteredLookup('SAAS') });
    let counted = false;
    await runWithContext(aRequestContext({ tenantId: TENANT as never }), () =>
      service.enforceLimit('users', 1, () => {
        counted = true;
        return Promise.resolve(0);
      }),
    );
    expect(counted).toBe(false);
  });

  it('refuses growth in grace before it ever counts', async () => {
    const service = entitlementsWith({
      lookup: new ScriptedLookup({ kind: 'SNAPSHOT', snapshot: snapshot() }),
      clock: new FakeClock(new Date('2026-06-05T00:00:00Z')),
    });
    await runWithContext(aRequestContext({ tenantId: TENANT as never }), async () => {
      await expect(
        service.enforceLimit('users', 1, () => Promise.resolve(0)),
      ).rejects.toMatchObject({
        details: { reason: 'SUBSCRIPTION_RESTRICTED', status: 'GRACE_PERIOD' },
      });
    });
  });
});

describe('EntitlementGuard', () => {
  function reflector(metadata: Record<string, unknown>): Reflector {
    return { getAllAndOverride: (key: string) => metadata[key] } as unknown as Reflector;
  }
  function http(method: string): ExecutionContext {
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ method }) }),
    } as unknown as ExecutionContext;
  }
  const expired = () =>
    entitlementsWith({
      lookup: new ScriptedLookup({ kind: 'SNAPSHOT', snapshot: snapshot() }),
      clock: new FakeClock(new Date('2026-07-01T00:00:00Z')),
    });
  const inContext = <T>(fn: () => Promise<T>, overrides = {}) =>
    runWithContext(aRequestContext({ tenantId: TENANT as never, ...overrides }), fn);

  it('an expired subscription keeps reads and refuses every write verb, annotated or not', async () => {
    const guard = new EntitlementGuard(reflector({}), expired());
    await inContext(async () => {
      await expect(guard.canActivate(http('GET'))).resolves.toBe(true);
      for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        await expect(guard.canActivate(http(verb))).rejects.toBeInstanceOf(
          SubscriptionRequiredError,
        );
      }
    });
  });

  it('never asks about a public route', async () => {
    const guard = new EntitlementGuard(
      reflector({ [PUBLIC_ROUTE]: 'health' }),
      entitlementsWith({ lookup: new ScriptedLookup({ kind: 'NONE', reason: 'x' }) }),
    );
    await expect(guard.canActivate(http('POST'))).resolves.toBe(true);
  });

  it('a declared operation overrides the verb', async () => {
    const guard = new EntitlementGuard(
      reflector({ [LICENSED_OPERATION]: { operation: 'GROWTH', reason: 'creates a seat' } }),
      entitlementsWith({
        lookup: new ScriptedLookup({ kind: 'SNAPSHOT', snapshot: snapshot() }),
        clock: new FakeClock(new Date('2026-06-05T00:00:00Z')),
      }),
    );
    await inContext(async () => {
      await expect(guard.canActivate(http('GET'))).rejects.toMatchObject({
        details: { reason: 'SUBSCRIPTION_RESTRICTED' },
      });
    });
  });

  it('a route feature and, for a machine caller, API access are both required', async () => {
    const service = entitlementsWith({
      lookup: new ScriptedLookup({ kind: 'SNAPSHOT', snapshot: snapshot() }),
      clock: new FakeClock(new Date('2026-01-01T00:00:00Z')),
    });
    const guard = new EntitlementGuard(
      reflector({ [REQUIRED_FEATURE]: DocsFeature.WEBHOOKS }),
      service,
    );
    await inContext(() => expect(guard.canActivate(http('GET'))).resolves.toBe(true));
    await inContext(
      () =>
        expect(guard.canActivate(http('GET'))).rejects.toMatchObject({
          details: { reason: 'FEATURE_NOT_INCLUDED' },
        }),
      { apiClientId: '019489f0-0000-7000-8000-0000000000aa' },
    );
  });

  it('refuses a token for one tenant against a snapshot for another', async () => {
    const guard = new EntitlementGuard(
      reflector({}),
      entitlementsWith({
        lookup: new ScriptedLookup({
          kind: 'SNAPSHOT',
          snapshot: snapshot({ tenantId: '019489f0-0000-7000-8000-000000000002' }),
        }),
        clock: new FakeClock(new Date('2026-01-01T00:00:00Z')),
      }),
    );
    await inContext(() =>
      expect(guard.canActivate(http('GET'))).rejects.toMatchObject({
        details: { reason: 'SUBJECT_MISMATCH' },
      }),
    );
  });
});

describe('LicenseFileLookup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'edms-licence-'));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pair = {
    kid: 'lic-1',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
  const issuer = new AsymmetricSigner('ES256', [pair]);
  const path = join(directory, 'docs.license');
  const lookup = new LicenseFileLookup({
    path,
    algorithm: 'ES256',
    publicKeys: [{ kid: pair.kid, publicKey: pair.publicKey }],
    installationId: 'inst-1',
  });
  const licence = (overrides: Record<string, unknown> = {}) =>
    armorLicense(
      issueLicense(
        {
          ...snapshot({ deployment: 'ON_PREMISES' }),
          deployment: 'ON_PREMISES',
          licenseId: 'lic_1',
          installationId: 'inst-1',
          issuedAt: '2026-01-01T00:00:00.000Z',
          notBefore: '2026-01-01T00:00:00.000Z',
          supersedes: null,
          ...overrides,
        },
        issuer,
      ),
    );
  const now = new Date('2026-02-01T00:00:00Z');

  it('verifies a licence on disk and re-reads it on every lookup, so renewal is a file copy', async () => {
    writeFileSync(path, licence());
    expect(await lookup.lookup(TENANT, null, now)).toMatchObject({ kind: 'SNAPSHOT' });
    writeFileSync(path, licence({ plan: { code: 'enterprise', version: 1 } }));
    const renewed = await lookup.lookup(TENANT, null, now);
    expect(renewed.kind === 'SNAPSHOT' && renewed.snapshot.plan.code).toBe('enterprise');
  });

  it('a missing file is an outage; a present but untrustworthy one is not', async () => {
    const missing = new LicenseFileLookup({
      path: join(directory, 'absent'),
      algorithm: 'ES256',
      publicKeys: [{ kid: pair.kid, publicKey: pair.publicKey }],
      installationId: 'inst-1',
    });
    expect(await missing.lookup(TENANT, null, now)).toMatchObject({ kind: 'UNAVAILABLE' });
    writeFileSync(path, licence({ installationId: 'inst-2' }));
    expect(await lookup.lookup(TENANT, null, now)).toEqual({
      kind: 'NONE',
      reason: 'LICENSE_WRONG_INSTALLATION',
    });
    writeFileSync(path, licence());
    expect(await lookup.lookup('019489f0-0000-7000-8000-000000000009', null, now)).toEqual({
      kind: 'NONE',
      reason: 'LICENSE_WRONG_TENANT',
    });
    expect(await lookup.lookup(TENANT, new Date('2026-05-01T00:00:00Z'), now)).toEqual({
      kind: 'NONE',
      reason: 'LICENSE_CLOCK_ROLLBACK',
    });
  });
});

describe('ControlPlaneLookup', () => {
  function port(
    result: OutboundResult,
  ): OutboundHttpPort & { url: string | null; auth: string | null } {
    const recorder = {
      url: null as string | null,
      auth: null as string | null,
      permits: () => Promise.resolve({ allowed: true, reason: null }),
      send: (request: { url: string; headers?: Readonly<Record<string, string>> }) => {
        recorder.url = request.url;
        recorder.auth = request.headers?.['authorization'] ?? null;
        return Promise.resolve(result);
      },
    };
    return recorder;
  }
  const ok = (status: number, body: string): OutboundResult => ({
    ok: true,
    response: { status, body, durationMs: 1 },
  });
  const settings = { url: 'https://control.munaxa.example', token: 't'.repeat(40) };

  it('asks for this product and tenant with the service credential', async () => {
    const http = port(ok(200, JSON.stringify(snapshot())));
    expect(await new ControlPlaneLookup(http, settings).lookup(TENANT)).toMatchObject({
      kind: 'SNAPSHOT',
    });
    expect(http.url).toBe(
      `https://control.munaxa.example/api/v1/products/docs/tenants/${TENANT}/entitlements`,
    );
    expect(http.auth).toBe(`Bearer ${'t'.repeat(40)}`);
  });

  it('a 404 is an answer, everything else that is not a valid snapshot for this tenant is an outage', async () => {
    const lookup = (r: OutboundResult) => new ControlPlaneLookup(port(r), settings).lookup(TENANT);
    expect((await lookup(ok(404, ''))).kind).toBe('NONE');
    expect((await lookup(ok(503, ''))).kind).toBe('UNAVAILABLE');
    expect((await lookup(ok(200, 'not json'))).kind).toBe('UNAVAILABLE');
    expect((await lookup(ok(200, JSON.stringify({ ...snapshot(), status: 'FOREVER' })))).kind).toBe(
      'UNAVAILABLE',
    );
    expect(
      (
        await lookup(
          ok(200, JSON.stringify(snapshot({ tenantId: '019489f0-0000-7000-8000-000000000002' }))),
        )
      ).kind,
    ).toBe('UNAVAILABLE');
    expect(
      (
        await lookup({
          ok: false,
          failure: { kind: 'REFUSED', reason: 'not allowed', durationMs: 0 },
        })
      ).kind,
    ).toBe('UNAVAILABLE');
  });
});
