import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { Permission, type AnyId, type RetentionScheduleStateKey, asId } from '@edms/domain';
import { type Page, skipFor, toPage } from '@edms/utils';

import type { ReportQuery, ReportRow, ReportSource } from '../../reporting/application/ports';
import { ACL_RESOLVER, type AclResolver } from '../../../core/authorization/acl-resolver.port';
import { documentVisibilityWhere } from '../../../core/authorization/document-visibility';
import { RecordStamps } from '../../../core/persistence';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';

/**
 * The expired-documents report, answered by Retention.
 *
 * ## The second door Phase 10 would otherwise have had
 *
 * The disposition queue is behind `retention:manage` — `retention.controller.ts` puts the whole
 * controller there, deliberately, and Phase 13's tile kept it. So this report requires
 * `retention:manage` **as well as** `report:view`: a report listing what is past its retention date
 * to a `report:view` holder would be the disposition register without the permission on it, and in
 * a compliance product knowing what is due for destruction is a narrower right than knowing what
 * exists.
 *
 * It is reach-scoped on top of that, through the schedule's document, so it is narrower than the
 * queue rather than wider.
 *
 * ## No `limit`, and that is the difference from `listDue`
 *
 * Phase 13 recorded the reason when it extracted `dueScheduleWhere`: `listDue` takes a limit
 * because the sweep *processes* what it reads, and a figure that stopped at the batch size would
 * sit at "200" through a backlog of any size. This is a paged report, so its total is the real one
 * — which is the whole point of asking a report rather than reading a tile.
 *
 * The predicate is nonetheless built beside `dueScheduleWhere`'s own rule rather than a second
 * reading of it: "due" means `due_at <= now` and a state that has not yet been executed or
 * cancelled, and the `state` parameter narrows *within* that rather than replacing it.
 */
@Injectable()
export class RetentionReportSource implements ReportSource {
  constructor(
    private readonly stamps: RecordStamps,
    @Inject(ACL_RESOLVER) private readonly acl: AclResolver,
  ) {}

  async run(query: ReportQuery): Promise<Page<ReportRow>> {
    if (query.query !== 'expired-documents') {
      throw new Error(`Retention answers no report called ${query.query}.`);
    }
    const tx = requireTransaction();
    const now = this.stamps.now();
    const from = query.dates['from'];
    const to = query.dates['to'];

    const where: Prisma.RetentionScheduleWhereInput = {
      tenantId: requireContext().tenantId,
      // Past its date. The range narrows *which* past dates rather than replacing the rule, so a
      // caller asking for last quarter gets last quarter's overdue schedules and not last
      // quarter's schedules regardless of whether they came due.
      dueAt: {
        lte: to === undefined || to.getTime() > now.getTime() ? now : to,
        ...(from !== undefined && { gte: from }),
      },
      ...(query.strings['state'] !== undefined
        ? { state: query.strings['state'] as RetentionScheduleStateKey }
        : // Executed and cancelled schedules are not "expired documents": one has already been
          // disposed of and the other was withdrawn. Naming the two live states rather than
          // excluding the two dead ones means a state added later is absent until somebody decides
          // it belongs, which is the safe direction for a compliance list.
          { state: { in: ['PENDING', 'IN_REVIEW', 'SUSPENDED'] } }),
      document: await this.documentReach(),
    };

    const [rows, total] = await Promise.all([
      tx.retentionSchedule.findMany({
        where,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        skip: skipFor(query.page),
        take: query.page.pageSize,
        select: {
          trigger: true,
          disposition: true,
          state: true,
          dueAt: true,
          document: {
            select: {
              documentNumber: true,
              title: true,
              // On the page, not per row. A live hold is what makes a due schedule *not* act, and
              // a report of what is due that did not say which rows are frozen would send somebody
              // to approve dispositions the sweep is going to refuse anyway.
              legalHolds: { where: { releasedAt: null }, select: { id: true }, take: 1 },
            },
          },
        },
      }),
      tx.retentionSchedule.count({ where }),
    ]);

    return toPage(
      rows.map((row): ReportRow => ({
        documentNumber: row.document.documentNumber,
        title: row.document.title,
        trigger: row.trigger,
        disposition: row.disposition,
        state: row.state,
        dueAt: row.dueAt,
        overdueDays: Math.max(Math.floor((now.getTime() - row.dueAt.getTime()) / 86_400_000), 0),
        onLegalHold: row.document.legalHolds.length > 0 ? 'yes' : 'no',
      })),
      total,
      query.page,
    );
  }

  /** The caller's document reach, through the one translator (`core/authorization`). */
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
}
