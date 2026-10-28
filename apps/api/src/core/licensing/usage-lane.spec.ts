import { describe, expect, it } from 'vitest';

import { DocsLimit, QueueName } from '@edms/domain';

import type { AppConfig } from '../config';
import type { Logger } from '../observability/logger';
import { currentContext } from '../tenancy/tenant-context';
import type { TenantRegistry } from '../tenancy/tenant-registry.port';
import type {
  OutboundHttpPort,
  OutboundRequest,
  OutboundResult,
} from '../../ports/outbound-http.port';
import type { JobEnvelope, QueuePort } from '../../ports/queue.port';
import { FakeClock } from '../../testing/fake-ports';
import { UsageLaneConsumer } from './usage-lane.consumer';
import { UsageMeters } from './usage-meters';

const TENANTS = ['019489f0-0000-7000-8000-0000000000c1', '019489f0-0000-7000-8000-0000000000c2'];
const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

function laneWith(options: {
  readonly controlPlane?: { url: string; token: string } | null;
  readonly answer?: OutboundResult;
}) {
  const sent: OutboundRequest[] = [];
  const enqueued: { payload: unknown; jobId: string | undefined }[] = [];
  const subscribed: string[] = [];
  const measuredFor: (string | undefined)[] = [];
  const meters = new UsageMeters();
  meters.register({
    metric: DocsLimit.USERS,
    measure: () => {
      measuredFor.push(currentContext()?.tenantId);
      return Promise.resolve(12);
    },
  });
  meters.register({ metric: DocsLimit.STORAGE_BYTES, measure: () => Promise.resolve(2048.9) });
  const http = {
    send: (request: OutboundRequest) => {
      sent.push(request);
      return Promise.resolve(
        options.answer ?? { ok: true, response: { status: 200, body: '{}', durationMs: 3 } },
      );
    },
  } as unknown as OutboundHttpPort;
  const lane = new UsageLaneConsumer(
    {
      subscribe: (queue: string) => {
        subscribed.push(queue);
        return Promise.resolve();
      },
    },
    {
      schedule: () => Promise.resolve(),
      enqueue: (_queue: string, payload: unknown, opts?: { jobId?: string }) => {
        enqueued.push({ payload, jobId: opts?.jobId });
        return Promise.resolve();
      },
    } as unknown as QueuePort,
    { all: () => Promise.resolve(TENANTS.map((id) => ({ id }))) } as unknown as TenantRegistry,
    {
      queue: { consumersEnabled: true },
      licensing: {
        controlPlane:
          options.controlPlane === undefined
            ? { url: 'https://control.munaxa.test', token: 'mxc_secret' }
            : options.controlPlane,
      },
    } as unknown as AppConfig,
    new FakeClock(new Date('2026-10-26T14:42:10.000Z')),
    quiet,
    { run: <T>(work: () => Promise<T>) => work() },
    http,
    meters,
  );
  const job = (payload: Record<string, unknown>) =>
    lane.handle({ jobId: 'j1', payload } as unknown as JobEnvelope);
  return { lane, sent, enqueued, subscribed, measuredFor, job };
}

describe('the usage lane', () => {
  it('declares nothing unless this deployment reports to the central service', async () => {
    const offline = laneWith({ controlPlane: null });
    await offline.lane.onApplicationBootstrap();
    expect(offline.subscribed).toEqual([]);
    const hosted = laneWith({});
    await hosted.lane.onApplicationBootstrap();
    expect(hosted.subscribed).toEqual([QueueName.LICENSING_USAGE]);
  });

  it('fans out one job per tenant, each carrying the hour the firing belongs to', async () => {
    const { enqueued, job } = laneWith({});
    await job({ kind: 'licensing.report-usage-fanout' });
    expect(enqueued).toEqual(
      TENANTS.map((tenantId) => ({
        payload: {
          kind: 'licensing.report-usage-tenant',
          tenantId,
          measuredAt: '2026-10-26T14:00:00.000Z',
        },
        jobId: `licensing.report-usage-tenant:${tenantId}:2026-10-26T14:00:00.000Z`,
      })),
    );
  });

  it('measures inside the tenant and reports whole levels with the credential', async () => {
    const tenantId = TENANTS[0] as string;
    const { sent, measuredFor, job } = laneWith({});
    await job({
      kind: 'licensing.report-usage-tenant',
      tenantId,
      measuredAt: '2026-10-26T14:00:00.000Z',
    });

    expect(measuredFor).toEqual([tenantId]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('https://control.munaxa.test/api/v1/products/docs/usage');
    expect(sent[0]?.headers?.['authorization']).toBe('Bearer mxc_secret');
    expect(JSON.parse(sent[0]?.body ?? '')).toEqual({
      reports: [
        { tenantId, metric: 'users', value: 12, measuredAt: '2026-10-26T14:00:00.000Z' },
        { tenantId, metric: 'storage.bytes', value: 2048, measuredAt: '2026-10-26T14:00:00.000Z' },
      ],
    });
  });

  it('throws a refusal so the lane retries it, without the credential in the message', async () => {
    const refused = laneWith({
      answer: { ok: true, response: { status: 401, body: '', durationMs: 1 } },
    });
    const report = refused.job({
      kind: 'licensing.report-usage-tenant',
      tenantId: TENANTS[0],
      measuredAt: '2026-10-26T14:00:00.000Z',
    });
    await expect(report).rejects.toThrow('Usage report refused: HTTP 401');
    await expect(report).rejects.not.toThrow(/mxc_secret/);
  });

  it('refuses a metric registered twice, at boot', () => {
    const meters = new UsageMeters();
    meters.register({ metric: DocsLimit.USERS, measure: () => Promise.resolve(0) });
    expect(() =>
      meters.register({ metric: DocsLimit.USERS, measure: () => Promise.resolve(0) }),
    ).toThrow(/Two usage meters/);
  });
});
