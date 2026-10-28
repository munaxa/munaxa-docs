import type { EntitlementSnapshot } from '@munaxa/licensing';
import { describe, expect, it, vi } from 'vitest';

import { DocsFeature, QueueName } from '@edms/domain';

import type { AppConfig } from '../../../core/config';
import type { EntitlementLookup } from '../../../core/licensing/licensing.ports';
import type { Logger } from '../../../core/observability/logger';
import type { TenantRegistry } from '../../../core/tenancy/tenant-registry.port';
import type { JobEnvelope, QueueConsumer, QueuePort } from '../../../ports/queue.port';
import { FakeClock } from '../../../testing/fake-ports';
import { entitlementsWith } from '../../../testing/licensing';
import type { AuditSinkService } from '../application/audit-sink.service';
import { WebhookLaneConsumer } from '../infrastructure/webhook-lane.consumer';

const TENANT = '019489f0-0000-7000-8000-0000000000b1';
const clock = new FakeClock();

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

/** The central service's answer for this tenant: a plan with these features, in this status. */
function planWith(
  features: readonly string[],
  status: EntitlementSnapshot['status'] = 'ACTIVE',
): EntitlementLookup {
  return {
    source: 'CONTROL_PLANE',
    cachesSnapshots: false,
    lookup: () =>
      Promise.resolve({
        kind: 'SNAPSHOT',
        snapshot: {
          schemaVersion: 1,
          customerId: 'cus_1',
          tenantId: TENANT,
          product: 'docs',
          deployment: 'SAAS',
          subscriptionId: 'sub_1',
          plan: { code: 'business', version: 1 },
          status,
          trialEndsAt: null,
          expiresAt: null,
          graceUntil: null,
          features: [...features],
          limits: {},
          resolvedAt: clock.now().toISOString(),
        },
      }),
  };
}

/** The consumer, subscribed to its two lanes through a consumer double that keeps the handlers. */
async function laneFor(lookup: EntitlementLookup) {
  const handlers = new Map<string, (job: JobEnvelope) => Promise<void>>();
  const consumer = {
    subscribe: (queue: string, handler: (job: JobEnvelope) => Promise<void>) => {
      handlers.set(queue, handler);
      return Promise.resolve();
    },
  } as unknown as QueueConsumer;
  const queue = { schedule: () => Promise.resolve(), enqueue: () => Promise.resolve() };
  const deliveries = {
    fanOut: vi.fn(() => Promise.resolve(1)),
    retryDue: vi.fn(() => Promise.resolve(0)),
  };
  const sinks = { push: vi.fn(() => Promise.resolve({ sent: 0 })) };
  const lane = new WebhookLaneConsumer(
    consumer,
    queue as unknown as QueuePort,
    { all: () => Promise.resolve([]) } as unknown as TenantRegistry,
    { queue: { consumersEnabled: true } } as AppConfig,
    clock,
    quiet,
    deliveries,
    sinks as unknown as AuditSinkService,
    entitlementsWith({ lookup, clock }),
  );
  await lane.onApplicationBootstrap();
  const run = (name: string, payload: Record<string, unknown>) =>
    handlers.get(name)?.({ jobId: `job-${name}`, payload } as unknown as JobEnvelope);
  const event = () =>
    run(QueueName.WEBHOOKS_DELIVER, {
      tenantId: TENANT,
      eventId: '019489f0-0000-7000-8000-0000000000e1',
      eventType: 'document.published',
      aggregateType: 'document',
      aggregateId: '019489f0-0000-7000-8000-0000000000d1',
      payload: {},
    });
  const retry = () =>
    run(QueueName.WEBHOOKS_DELIVER, { kind: 'webhooks.retry-tenant', tenantId: TENANT });
  const stream = () =>
    run(QueueName.AUDIT_STREAM, { kind: 'audit.stream-tenant', tenantId: TENANT });
  return { deliveries, sinks, event, retry, stream };
}

describe('the webhook and audit-stream lanes follow the plan', () => {
  it('deliver, retry and stream while the plan includes them', async () => {
    const lane = await laneFor(planWith([DocsFeature.WEBHOOKS, DocsFeature.AUDIT_STREAM]));
    await lane.event();
    await lane.retry();
    await lane.stream();
    expect(lane.deliveries.fanOut).toHaveBeenCalledTimes(1);
    expect(lane.deliveries.retryDue).toHaveBeenCalledTimes(1);
    expect(lane.sinks.push).toHaveBeenCalledTimes(1);
  });

  it('send nothing for a feature the plan does not include, each lane on its own feature', async () => {
    const webhooksOnly = await laneFor(planWith([DocsFeature.WEBHOOKS]));
    await webhooksOnly.event();
    await webhooksOnly.stream();
    expect(webhooksOnly.deliveries.fanOut).toHaveBeenCalledTimes(1);
    expect(webhooksOnly.sinks.push).not.toHaveBeenCalled();

    const streamOnly = await laneFor(planWith([DocsFeature.AUDIT_STREAM]));
    await streamOnly.event();
    await streamOnly.retry();
    await streamOnly.stream();
    expect(streamOnly.deliveries.fanOut).not.toHaveBeenCalled();
    expect(streamOnly.deliveries.retryDue).not.toHaveBeenCalled();
    expect(streamOnly.sinks.push).toHaveBeenCalledTimes(1);
  });

  it('keep delivering to a suspended tenant, whose own events are a read, but not a cancelled one', async () => {
    const suspended = await laneFor(planWith([DocsFeature.WEBHOOKS], 'SUSPENDED'));
    await suspended.event();
    expect(suspended.deliveries.fanOut).toHaveBeenCalledTimes(1);

    const cancelled = await laneFor(planWith([DocsFeature.WEBHOOKS], 'CANCELLED'));
    await cancelled.event();
    expect(cancelled.deliveries.fanOut).not.toHaveBeenCalled();
  });
});
