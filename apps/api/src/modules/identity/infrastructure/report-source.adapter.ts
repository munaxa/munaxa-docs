import { Injectable } from '@nestjs/common';

import type { UserId, UserStatusKey } from '@edms/domain';
import { type Page, skipFor, toPage } from '@edms/utils';

import type {
  ReportQuery,
  ReportRow,
  ReportSource,
  ReportSubjectReader,
} from '../../reporting/application/ports';
import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';

/**
 * The users report, answered by Identity.
 *
 * ## What is on it, and the four columns that are deliberately not
 *
 * A report is a file somebody keeps — on a laptop, in an email, in a shared drive — for longer than
 * any screen is open. So this carries exactly what the administration list already shows: who,
 * their address, their state, their roles, their department, whether they hold a second factor, and
 * when they last signed in.
 *
 * **No password hash, no second-factor secret, no recovery code, no session token.** None of them is
 * on `user` at all — Phase 14 put the enrolment in its own table precisely because `user` is read by
 * the directory, the recipient walk and every admin list, and a secret on that row is "one careless
 * projection away from a payload". A report is that careless projection, arriving eleven phases
 * later, and the table split is what makes writing one here take a deliberate join rather than a
 * `select: true`.
 *
 * `mfaEnrolled` is a *boolean*, which is the point of including it: "who has not set up a second
 * factor" is the question a security review asks, and answering it from a column that says only
 * yes or no discloses nothing about the factor itself.
 *
 * ## Tenant-wide, behind `user:manage`
 *
 * There is no per-row reach for an account: a person is not filed under a library. So the gate is
 * the whole of the discrimination, and it is the gate Phase 13 put on the equivalent tile —
 * `user:manage` beside `report:view`, because a report of the directory is the directory.
 */
@Injectable()
export class IdentityReportSource implements ReportSource {
  async run(query: ReportQuery): Promise<Page<ReportRow>> {
    if (query.query !== 'users') {
      throw new Error(`Identity answers no report called ${query.query}.`);
    }
    const tx = requireTransaction();
    const where = {
      tenantId: requireContext().tenantId,
      deletedAt: null,
      ...(query.strings['state'] !== undefined && {
        status: query.strings['state'] as UserStatusKey,
      }),
    };

    const [rows, total] = await Promise.all([
      tx.user.findMany({
        where,
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        skip: skipFor(query.page),
        take: query.page.pageSize,
        select: {
          displayName: true,
          email: true,
          status: true,
          mfaEnrolled: true,
          lastLoginAt: true,
          // Both joins are on the page, never per row: a page of fifty people resolving roles one
          // at a time is fifty round trips for a screen somebody runs at page size two hundred.
          roles: { select: { role: { select: { key: true } } } },
          departments: {
            where: { isPrimary: true },
            select: { department: { select: { name: true } } },
          },
        },
      }),
      tx.user.count({ where }),
    ]);

    return toPage(
      rows.map((row): ReportRow => ({
        displayName: row.displayName,
        email: row.email,
        state: row.status,
        // Role **keys**, sorted, joined — not names. A tenant renames its roles freely and the
        // keys are fixed, so a filter written against last quarter's export still matches. It is
        // the same rule Phase 9 set for audit action codes and Phase 13 restated: the code is
        // what somebody filters by, and a phrase in its place gives one thing two names.
        roles: row.roles
          .map((assignment) => assignment.role.key)
          .sort()
          .join(' '),
        department: row.departments[0]?.department.name ?? null,
        mfaEnrolled: row.mfaEnrolled ? 'yes' : 'no',
        lastSignInAt: row.lastLoginAt,
      })),
      total,
      query.page,
    );
  }
}

/**
 * Whose reach a queued export runs under — Phase 15's `REPORT_SUBJECT_READER`.
 *
 * Identity answers it because it is a question about a person, and the answer is read **at the
 * moment the export runs** rather than copied onto the export row when it was requested. That is
 * Phase 11's rule applied to a queue: authority is read at the instant of the decision, never
 * snapshotted, so a backlog cannot hand out reach that was withdrawn while the job waited.
 *
 * Role **keys**, because that is what a request context carries and what `AclRepository.roleIdsFor`
 * resolves — it takes keys or identifiers, so either would work, and keys are what an export
 * running "as if it were a request" should carry so the two paths are indistinguishable to
 * everything downstream.
 *
 * `null` for an account that is gone or not active, and the caller turns that into a refusal rather
 * than an empty report. Those are different answers, and a disabled account whose queued export
 * quietly produced zero rows would look exactly like a tenant with nothing in it.
 */
@Injectable()
export class IdentityReportSubjectReader implements ReportSubjectReader {
  async rolesFor(userId: UserId): Promise<readonly string[] | null> {
    const row = await requireTransaction().user.findFirst({
      where: {
        id: userId,
        tenantId: requireContext().tenantId,
        deletedAt: null,
        status: 'ACTIVE',
      },
      select: { roles: { select: { role: { select: { key: true, deletedAt: true } } } } },
    });
    if (row === null) {
      return null;
    }
    return row.roles
      .filter((assignment) => assignment.role.deletedAt === null)
      .map((assignment) => assignment.role.key);
  }
}
