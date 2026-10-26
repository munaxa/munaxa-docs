import { SetMetadata } from '@nestjs/common';
import type { OperationKind } from '@munaxa/licensing';

import type { DocsFeatureKey } from '@edms/domain';

export const LICENSED_OPERATION = 'edms:licensed-operation';
export const REQUIRED_FEATURE = 'edms:required-feature';

/**
 * Overrides what licensing treats this route as — ADR-0026.
 *
 * Without it a read verb is a `READ` and anything else is a `WRITE`. Two cases need saying out
 * loud: a route that *grows* a metered quantity (`GROWTH` — refused in grace, even though it is a
 * write), and a route that must stay reachable when only export remains (`EXPORT` — the export
 * itself, and what a client needs to reach it). The reason is mandatory, as it is on `@Public`,
 * because every one of these is a decision about what a customer keeps when they stop paying.
 */
export const LicensedAs = (
  operation: OperationKind,
  reason: string,
): MethodDecorator & ClassDecorator => SetMetadata(LICENSED_OPERATION, { operation, reason });

/**
 * The plan must include this feature. Checked before the permission, so "your plan does not include
 * webhooks" is the answer rather than "forbidden" (ADR-0012 §4). Never a substitute for
 * `@RequirePermission`: a route carrying this still needs its permission.
 */
export const RequireFeature = (feature: DocsFeatureKey): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_FEATURE, feature);
