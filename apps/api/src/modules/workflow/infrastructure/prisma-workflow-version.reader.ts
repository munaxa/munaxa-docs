import { Injectable } from '@nestjs/common';

import { workflowDefinitionBodySchema } from '@edms/contracts';
import { WorkflowVersionState, type WorkflowVersionId, asId } from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  PublishedWorkflowVersion,
  WorkflowVersionReader,
} from '../application/version-reader.port';

/**
 * Reading a version's rules, parsed.
 *
 * The stored `definition` is `jsonb`, validated against `@edms/contracts` when it was written and
 * again when it was published. It is parsed **again** here, and the third parse is not paranoia
 * about the first two: the row can be years old, and the schema it was written against can have
 * gained a field with a default since. Parsing on read is what applies those defaults, so the engine
 * never has to ask whether a stage it is about to run has a `maxEscalations` — a version published
 * before that field existed reads back with the default rather than with `undefined`.
 *
 * A version that will not parse is returned as null rather than thrown from. Submission then refuses
 * with "this workflow has no published version", which is the honest thing to tell an author: the
 * definition is unusable, and the person who can fix it is an administrator rather than them.
 */
@Injectable()
export class PrismaWorkflowVersionReader implements WorkflowVersionReader {
  async publishedVersionFor(definitionId: string): Promise<PublishedWorkflowVersion | null> {
    const row = await requireTransaction().workflowVersion.findFirst({
      where: {
        definitionId,
        tenantId: this.tenantId(),
        state: WorkflowVersionState.PUBLISHED,
        // A definition that has been deactivated stops being chosen for new approvals. Running ones
        // are untouched, which is what deactivation means as opposed to deletion.
        definitionRecord: { isActive: true, deletedAt: null },
      },
      // Newest published first. Publishing deprecates the previous one in the same transaction, so
      // there is only ever one — the ordering is what makes that true rather than assumed.
      orderBy: { version: 'desc' },
    });
    return row === null ? null : parse(row);
  }

  async versionById(id: WorkflowVersionId): Promise<PublishedWorkflowVersion | null> {
    const row = await requireTransaction().workflowVersion.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    return row === null ? null : parse(row);
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

function parse(row: {
  id: string;
  definitionId: string;
  version: number;
  state: string;
  definition: unknown;
}): PublishedWorkflowVersion | null {
  const parsed = workflowDefinitionBodySchema.safeParse(row.definition);
  if (!parsed.success) {
    return null;
  }
  return {
    id: asId<WorkflowVersionId>(row.id),
    definitionId: row.definitionId,
    version: row.version,
    state: row.state as PublishedWorkflowVersion['state'],
    definition: parsed.data,
  };
}
