import { Injectable } from '@nestjs/common';

import { type Page, skipFor, toPage } from '@edms/utils';

import type { ReportQuery, ReportRow, ReportSource } from '../../reporting/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';

/**
 * The departments report, answered by Organization.
 *
 * Phase 13's tile was a single number — how many departments exist — behind `org:manage`. This is
 * that number with the structure it summarised: each department, its entity, how many people belong
 * to it and how many of those manage it. The gate is unchanged, deliberately: a report over the
 * organisation chart is the organisation chart, and Phase 13 already decided which permission that
 * is.
 *
 * **Counts of people, never their names.** "Who is in the finance department" is the directory,
 * behind `user:manage`, and answering it from a report gated on `org:manage` would be the second
 * door this phase's whole catalogue rule exists to close. `_count` is what a `groupBy` over the
 * membership table gives, so the query cannot accidentally return a person.
 */
@Injectable()
export class OrganizationReportSource implements ReportSource {
  async run(query: ReportQuery): Promise<Page<ReportRow>> {
    if (query.query !== 'departments') {
      throw new Error(`Organization answers no report called ${query.query}.`);
    }
    const tx = requireTransaction();
    const where = { tenantId: requireContext().tenantId, deletedAt: null };

    const [rows, total] = await Promise.all([
      tx.department.findMany({
        where,
        orderBy: [{ path: 'asc' }],
        skip: skipFor(query.page),
        take: query.page.pageSize,
        select: {
          name: true,
          entity: { select: { name: true } },
          members: { select: { isManager: true } },
        },
      }),
      tx.department.count({ where }),
    ]);

    return toPage(
      rows.map((row): ReportRow => ({
        department: row.name,
        entity: row.entity.name,
        members: row.members.length,
        // A department with no manager reports zero rather than being omitted: "which departments
        // have nobody accountable for them" is the question this column exists to answer, and it
        // is answered by the zeros.
        managers: row.members.filter((member) => member.isManager).length,
      })),
      total,
      query.page,
    );
  }
}
