import { z } from 'zod';

/**
 * Health contracts. Three endpoints, three different questions
 * (`docs/architecture/20-deployment-architecture.md`):
 *
 * - **liveness** — is the process wedged? Never touches a dependency, so a slow database
 *   cannot get every pod restarted.
 * - **readiness** — may traffic be routed here? Checks the dependencies a request needs.
 * - **health** — the operator-facing detail behind readiness.
 */
export const dependencyStatusSchema = z.enum(['UP', 'DEGRADED', 'DOWN']);

export const dependencyCheckSchema = z.object({
  name: z.string(),
  status: dependencyStatusSchema,
  latencyMs: z.number().int().min(0).optional(),
  /** Operator-facing reason. Never carries a connection string or a credential. */
  detail: z.string().optional(),
});

export const healthReportSchema = z.object({
  status: dependencyStatusSchema,
  version: z.string(),
  checkedAt: z.string().datetime(),
  dependencies: z.array(dependencyCheckSchema),
});

export const livenessSchema = z.object({
  status: z.literal('UP'),
  uptimeSeconds: z.number().int().min(0),
});

export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;
export type HealthReport = z.infer<typeof healthReportSchema>;
export type Liveness = z.infer<typeof livenessSchema>;
