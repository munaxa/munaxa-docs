import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { Permission, type AnyId, type ApprovalTaskStateKey, asId } from '@edms/domain';
import { type Page, skipFor, toPage } from '@edms/utils';

import type { ReportQuery, ReportRow, ReportSource } from '../../reporting/application/ports';
import { ACL_RESOLVER, type AclResolver } from '../../../core/authorization/acl-resolver.port';
import { documentVisibilityWhere } from '../../../core/authorization/document-visibility';
import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { approvalTaskWhere } from './prisma-approval-query.repository';

/**
 * The approvals and workflow reports, answered by Workflow.
 *
 * ## Reach is applied through the *document*, not through the assignee
 *
 * This is the decision in this file. An approval task has an assignee, and the inbox filters on it —
 * that is what makes the inbox one person's list, and `approvalTaskWhere` is where it lives. A
 * *report* on approvals is not one person's list: "which documents were approved last quarter, and
 * how long did each take" is a question about records, and answering it only for the caller's own
 * tasks would produce a report nobody could use for the thing reports exist for.
 *
 * So the report crosses assignees and is scoped by the reach of the **document** the task belongs
 * to, through the same `visibilityFilter` regions the document list uses. That has two
 * consequences worth stating rather than discovering:
 *
 * - Somebody can see that a colleague approved a document — but only a document they could have
 *   opened themselves, where the approval timeline already shows them exactly that (Phase 4's
 *   `/documents/{id}/approvals`). The report adds no disclosure; it adds paging and an export.
 * - It is **not** a report on a person. There is an `assigneeId` filter, and it narrows within what
 *   the caller can already reach — so it cannot be used to enumerate somebody's workload in a part
 *   of the tenant the caller has no access to. Phase 13 refused a tenant-wide "who is covering for
 *   whom" for the same reason, and that refusal still stands: this report names tasks on documents,
 *   never absences.
 *
 * The predicate is composed with `approvalTaskWhere` rather than rewritten, so there is still
 * exactly one `dueAt < now` in this module — the property Phase 13 established when it extracted
 * that function, and the property that keeps "overdue" meaning one thing.
 */
@Injectable()
export class WorkflowReportSource implements ReportSource {
  constructor(
    private readonly stamps: RecordStamps,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
  ) {}

  run(query: ReportQuery): Promise<Page<ReportRow>> {
    switch (query.query) {
      case 'approvals':
        return this.approvals(query);
      case 'workflow':
        return this.workflow(query);
      default:
        throw new Error(`Workflow answers no report called ${query.query}.`);
    }
  }

  private async approvals(query: ReportQuery): Promise<Page<ReportRow>> {
    const tx = requireTransaction();
    const now = this.stamps.now();
    const assignee = query.strings['assigneeId'];
    const where: Prisma.ApprovalTaskWhereInput = {
      AND: [
        approvalTaskWhere({
          tenantId: requireContext().tenantId,
          assigneeIds: assignee === undefined ? [] : [assignee],
          state: query.strings['state'] as ApprovalTaskStateKey | undefined,
          overdue: query.booleans['overdueOnly'],
          now,
        }),
        { instance: { document: await this.documentReach() } },
        ...this.range(query),
      ],
    };

    const [rows, total] = await Promise.all([
      tx.approvalTask.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: skipFor(query.page),
        take: query.page.pageSize,
        select: {
          state: true,
          decision: true,
          createdAt: true,
          decidedAt: true,
          dueAt: true,
          assignee: { select: { displayName: true } },
          stage: { select: { name: true } },
          instance: {
            select: { document: { select: { title: true, documentNumber: true } } },
          },
        },
      }),
      tx.approvalTask.count({ where }),
    ]);

    return toPage(
      rows.map((row): ReportRow => {
        const document = row.instance.document;
        return {
          documentNumber: document.documentNumber,
          documentTitle: document.title,
          stage: row.stage.name,
          assignee: row.assignee.displayName,
          // The decision when there is one, the state when there is not — one column, because a
          // report with both would have a blank in one of them on every row.
          state: row.decision ?? row.state,
          assignedAt: row.createdAt,
          dueAt: row.dueAt,
          decidedAt: row.decidedAt,
          hoursToDecide: hoursBetween(row.createdAt, row.decidedAt),
          // Against `now` for a task still waiting, and against the decision for one already
          // taken: "was it late" is a question about when it was decided, and a decided task
          // does not become more overdue as the report ages.
          overdue: isOverdue(row.dueAt, row.decidedAt ?? now) ? 'yes' : 'no',
        };
      }),
      total,
      query.page,
    );
  }

  /**
   * Workflow instances per month — the one report in this phase with a genuine time axis, and
   * therefore the one Phase 13 was pointing at when it recorded "no trend, no time axis, no charts …
   * the trends that would earn one are Phase 15's".
   *
   * Bucketed in this process rather than by `date_trunc` in SQL, and that is the one place in this
   * phase where the obvious optimisation was refused. Grouping by an expression needs `$queryRaw`,
   * and a raw query cannot take the reach predicate: `documentVisibilityWhere` produces a Prisma
   * `where`, and hand-writing its SQL equivalent here would be the second implementation of the
   * regions walk that this whole seam exists to prevent. Resolving the reach to a list of document
   * identifiers first would work and would be unbounded in exactly the dimension that matters.
   *
   * So the reach stays a join predicate, the rows come back projected to three columns, and the
   * read is bounded by `MAX_INSTANCES` — stated in the report's cost table rather than hoped for.
   * A tenant whose approval history exceeds it wants the export, which pages.
   */
  private async workflow(query: ReportQuery): Promise<Page<ReportRow>> {
    const tx = requireTransaction();
    const tenantId = requireContext().tenantId;
    const where: Prisma.WorkflowInstanceWhereInput = {
      tenantId,
      document: await this.documentReach(),
      ...this.instanceRange(query),
    };

    const rows = await tx.workflowInstance.findMany({
      where,
      select: { state: true, startedAt: true, endedAt: true },
      // Bounded by the range the caller asked for. An unbounded report over a tenant's whole
      // history is the one query in this phase that could scan a large table, so it takes the
      // export's own page bound as its ceiling and says so in the total.
      take: MAX_INSTANCES,
      orderBy: { startedAt: 'asc' },
    });

    const periods = new Map<
      string,
      { started: number; completed: number; rejected: number; running: number }
    >();
    const bucket = (key: string) => {
      const existing = periods.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const created = { started: 0, completed: 0, rejected: 0, running: 0 };
      periods.set(key, created);
      return created;
    };

    for (const row of rows) {
      const entry = bucket(month(row.startedAt));
      entry.started += 1;
      if (row.state === 'RUNNING' || row.state === 'PAUSED') {
        entry.running += 1;
      }
      if (row.endedAt !== null) {
        // Counted in the month it *ended*, not the month it started: "how many approvals completed
        // in March" is a question about March, and attributing a March completion to a January
        // start would make every month's completions arrive late and out of order.
        const ended = bucket(month(row.endedAt));
        if (row.state === 'REJECTED') {
          ended.rejected += 1;
        } else if (row.state === 'COMPLETED') {
          ended.completed += 1;
        }
      }
    }

    const entries = [...periods.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([period, counts]): ReportRow => ({ period, ...counts }));

    const start = skipFor(query.page);
    return toPage(entries.slice(start, start + query.page.pageSize), entries.length, query.page);
  }

  /**
   * The caller's document reach, as a `where` on the related document.
   *
   * Resolved through `ACL_RESOLVER` — the same call `PrismaDocumentRepository.visibilityCondition`
   * makes — so a task on a document absent from the library list is absent here too. It is written
   * as a nested `document: { … }` rather than by collecting identifiers, so the filter stays a join
   * predicate and the count stays a count rather than a length.
   *
   * A caller with no user is not filtered, exactly as the document list is not: that path is the
   * outbox consumers and the schedules, which have no reach question to answer. A report export
   * never reaches it — `report-export.service.ts` reconstitutes the requester before any source
   * runs, and that is the property its own header exists to state.
   */
  private async documentReach(): Promise<Prisma.DocumentWhereInput> {
    const context = requireContext();
    if (context.userId === null) {
      return {};
    }
    const filter = await this.acl.visibilityFilter(
      {
        userId: asId(context.userId),
        roleIds: context.roles.map((role) => asId<AnyId>(role)),
        departmentIds: [],
        delegationIds: [],
      },
      Permission.DOCUMENT_VIEW,
    );
    return documentVisibilityWhere(filter);
  }

  private range(query: ReportQuery): Prisma.ApprovalTaskWhereInput[] {
    const from = query.dates['from'];
    const to = query.dates['to'];
    if (from === undefined && to === undefined) {
      return [];
    }
    return [
      {
        createdAt: {
          ...(from !== undefined && { gte: from }),
          ...(to !== undefined && { lte: to }),
        },
      },
    ];
  }

  private instanceRange(query: ReportQuery): Prisma.WorkflowInstanceWhereInput {
    const from = query.dates['from'];
    const to = query.dates['to'];
    if (from === undefined && to === undefined) {
      return {};
    }
    return {
      startedAt: {
        ...(from !== undefined && { gte: from }),
        ...(to !== undefined && { lte: to }),
      },
    };
  }
}

/** As many instances as the trend report reads. Bounded work, stated rather than hoped for. */
const MAX_INSTANCES = 50_000;

/** `YYYY-MM`, in UTC — the same instant everywhere, which is what every stored timestamp is. */
function month(at: Date): string {
  return at.toISOString().slice(0, 7);
}

function hoursBetween(from: Date, to: Date | null): number | null {
  return to === null ? null : Math.round(((to.getTime() - from.getTime()) / 3_600_000) * 10) / 10;
}

function isOverdue(dueAt: Date | null, at: Date): boolean {
  return dueAt !== null && dueAt.getTime() < at.getTime();
}
