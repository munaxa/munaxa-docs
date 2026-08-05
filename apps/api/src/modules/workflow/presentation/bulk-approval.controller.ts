import { Body, Controller, Post } from '@nestjs/common';

import {
  type BulkApprovalBody,
  type BulkOperationResult,
  bulkApprovalSchema,
} from '@edms/contracts';
import { Permission } from '@edms/domain';

import { RequirePermission } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import { BulkApprovalService } from '../application/bulk-approval.service';

/**
 * Deciding many approval tasks at once.
 *
 * Its own controller rather than a method on `ApprovalController`, for the same reason the bulk
 * document routes are their own: the permission story is different. The single-object decision
 * carries `document:approve` and adds `document:reject` when the decision is a rejection; this one
 * cannot reject at all, so `document:reject` is unreachable through it and the class says so by
 * never naming it.
 *
 * There is no `@ScopedTo`, and the absence is the design. Reach is decided at the **document** each
 * task belongs to, there are N of them, and the decorator binds one route parameter to one object.
 * `DefaultBulkExecutor` makes that decision per task through the same `ACL_RESOLVER` the guard
 * would have used, inside the transaction that decides it — and the engine's own delegation
 * authority check runs after, unchanged, because `apply` calls `decide`.
 */
@Controller({ path: 'approval-tasks/bulk', version: '1' })
export class BulkApprovalController {
  constructor(private readonly bulk: BulkApprovalService) {}

  @Post('decisions')
  @RequirePermission(Permission.DOCUMENT_APPROVE)
  async decide(
    @Body(new ZodValidationPipe(bulkApprovalSchema)) body: BulkApprovalBody,
  ): Promise<BulkOperationResult> {
    const result = await this.bulk.decide({
      taskIds: body.taskIds,
      decision: body.decision,
      comment: body.comment ?? null,
    });
    return {
      operationId: result.operationId,
      kind: 'APPROVAL',
      state: result.state,
      tally: result.tally,
      items: result.items.map((item) => ({
        targetId: item.targetId,
        outcome: item.outcome,
        errorCode: item.errorCode,
        detail: item.detail,
      })),
    };
  }
}
