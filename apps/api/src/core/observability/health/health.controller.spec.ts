import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { DependencyStatus, HealthReport } from '@edms/contracts';

import type { ClockPort } from '../../../ports/clock.port';
import { HealthController } from './health.controller';
import type { HealthService } from './health.service';

/**
 * The readiness status line, guarded — Phase 9.2.
 *
 * A real deployment answered `200 OK` on `/api/health/ready` while the body of the same response
 * read `"status":"DOWN"` with both tenant databases unreachable. Nothing caught it because nothing
 * asserted the status *code*: every existing test read the body, and a load balancer never does.
 *
 * These assert the code and the body together, because either one alone is what let the defect
 * through — a body-only test passes on the broken controller, and a code-only test would pass on a
 * controller that returned 503 with nothing an operator could act on.
 */
describe('the readiness probe a load balancer keys on', () => {
  it('answers 503 when a dependency is down, and still names which one', async () => {
    const { controller, response } = build('DOWN');

    const report = await controller.ready(response.handle);

    expect(response.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(report.status).toBe('DOWN');
    expect(report.dependencies.map((dependency) => dependency.name)).toContain('database:acme');
  });

  it('answers 200 when every dependency is up', async () => {
    const { controller, response } = build('UP');

    const report = await controller.ready(response.handle);

    expect(response.statusCode).toBe(HttpStatus.OK);
    expect(report.status).toBe('UP');
  });

  // Degraded is deliberately still routable: it means nothing is down and something is slow, and
  // pulling every instance out of rotation for it empties the pool during a degradation.
  it('keeps a degraded instance in rotation', async () => {
    const { controller, response } = build('DEGRADED');

    const report = await controller.ready(response.handle);

    expect(response.statusCode).toBe(HttpStatus.OK);
    expect(report.status).toBe('DEGRADED');
  });
});

function build(status: DependencyStatus): {
  controller: HealthController;
  response: { handle: Parameters<HealthController['ready']>[0]; statusCode: number | null };
} {
  const report: HealthReport = {
    status,
    version: '0.1.0',
    checkedAt: '2026-08-16T00:00:00.000Z',
    dependencies: [
      {
        name: 'database:acme',
        status,
        latencyMs: 1,
        ...(status === 'UP' ? {} : { detail: 'PrismaClientInitializationError' }),
      },
      { name: 'cache', status: 'UP', latencyMs: 1 },
    ],
  };

  const recorder = { statusCode: null as number | null };
  const handle = {
    status(code: number) {
      recorder.statusCode = code;
      return this;
    },
  } as unknown as Parameters<HealthController['ready']>[0];

  const health = { report: () => Promise.resolve(report) } as unknown as HealthService;
  const clock = { now: () => new Date('2026-08-16T00:00:00.000Z') } as unknown as ClockPort;

  return {
    controller: new HealthController(health, clock),
    response: {
      handle,
      get statusCode() {
        return recorder.statusCode ?? -1;
      },
    },
  };
}
