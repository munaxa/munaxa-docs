import { Injectable } from '@nestjs/common';

import type { AuditOutcomeKey, AuditSubjectTypeKey, UserId } from '@edms/domain';
import { type Page, toPage } from '@edms/utils';

import type { ReportQuery, ReportRow, ReportSource } from '../../reporting/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { AuditReadService } from '../application/audit-read.service';

/**
 * The audit report — and the decision it turns on is that it is **not a second reader**.
 *
 * Phase 9 decided that the audit search is deliberately *not* ACL-filtered, and 08 §10 records why:
 * a search spans subjects, so there is no single object to resolve, and `audit:view` is granted to
 * exactly the three roles whose definition is reading the trail. Narrowing an auditor's search by
 * document ACLs "would produce an auditor who cannot audit". 13 §1 is equally emphatic that the
 * trail has one reader.
 *
 * A report over the trail is that same thing wearing a different name. Two answers were available:
 *
 * - **Build a second query here**, gated on `report:view`. Refused, and it is the more tempting of
 *   the two because it is less code: it would be a second definition of what the trail contains,
 *   diverging the first time a filter was added to one of them, and it would put the trail behind a
 *   permission 08 §6 grants to three roles the audit screen does not.
 * - **Call the reader that already exists.** Taken. This adapter is a projection over
 *   `AuditReadService.search`, and the catalogue requires `audit:view` **as well as** `report:view`
 *   — so the report can never be reached by somebody the `/audit` screen refuses. What it adds over
 *   that screen is an export somebody keeps, which is the only thing a report was ever for here.
 *
 * ## And it is not an evidence bundle, which is the distinction worth keeping sharp
 *
 * Phase 9's bundle carries the chain, the checkpoints and a signed manifest stating exactly which
 * columns each digest attests, and it stays behind `audit:export`. This is a spreadsheet of rows
 * with no hashes on it and no manifest beside it — deliberately, because a file that carried
 * `hash` and `previous_hash` columns without the manifest's `attests` section would look like
 * evidence and prove nothing. Somebody who needs evidence uses the bundle; somebody who needs a
 * quarterly summary uses this.
 */
@Injectable()
export class AuditReportSource implements ReportSource {
  constructor(private readonly reader: AuditReadService) {}

  async run(query: ReportQuery): Promise<Page<ReportRow>> {
    if (query.query !== 'audit') {
      throw new Error(`Audit answers no report called ${query.query}.`);
    }
    const action = query.strings['action'];
    const page = await this.reader.search(
      {
        from: query.dates['from'] ?? null,
        to: query.dates['to'] ?? null,
        actorId: (query.strings['actorId'] as UserId | undefined) ?? null,
        actions: action === undefined ? [] : [action],
        subjectType: (query.strings['subjectType'] as AuditSubjectTypeKey | undefined) ?? null,
        subjectId: null,
        outcome: (query.strings['outcome'] as AuditOutcomeKey | undefined) ?? null,
        correlationId: null,
      },
      query.page,
    );

    const names = await this.namesFor(
      page.data.flatMap((event) => (event.actorId === null ? [] : [String(event.actorId)])),
    );

    return toPage(
      page.data.map((event): ReportRow => ({
        occurredAt: event.occurredAt,
        // The action code, verbatim. Phase 9's rule, restated by Phase 13: the code is what an
        // auditor filters by and what an evidence export contains, and a phrase in its place
        // would give one event two names — in a file that outlives the screen that rendered it.
        action: event.action,
        outcome: event.outcome,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        // The name where there is one, and the identifier where the account has gone. Audit
        // outlives its subject (13 §1), so a row whose actor was deleted still has an actor —
        // and blanking it would hide exactly the history that matters most.
        actor: event.actorId === null ? SYSTEM : (names.get(event.actorId) ?? event.actorId),
        reason: event.reason,
      })),
      page.meta.total,
      query.page,
    );
  }

  private async namesFor(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) {
      return new Map();
    }
    const rows = await requireTransaction().user.findMany({
      where: { tenantId: requireContext().tenantId, id: { in: unique } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((row) => [row.id, row.displayName] as const));
  }
}

/** What an act with no actor is called. Every actor column is nullable for exactly this case. */
const SYSTEM = 'SYSTEM';
