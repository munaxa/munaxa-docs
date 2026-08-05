import { Inject, Injectable } from '@nestjs/common';

import { Permission, type UserId } from '@edms/domain';

import type {
  DashboardDelegation,
  DashboardDelegationMetrics,
} from '../../dashboard/application/ports';
import {
  DELEGATION_SERVICE,
  type DelegationService,
  USER_DIRECTORY,
  type UserDirectory,
} from '../application/ports';

/**
 * Phase 11's deferred dashboard widget, answered by the module that owns delegation.
 *
 * Phase 11's report recorded "no delegation widget on the dashboard, including any 'who is covering
 * for whom' summary" as a limit, and this discharges it — **as the caller's own arrangements and
 * nothing wider**. `listActive(userId)` answers "in force for this person, in either direction", so
 * the card shows who is covering for me and whom I am covering for. There is no tenant-wide
 * "who is covering for whom" here and there deliberately is not: that is a report on everybody's
 * absences, it needs a permission nothing in the catalogue currently means, and inventing one to
 * fill a card would be this phase writing Phase 15's brief.
 *
 * `coveredBy` uses `document:approve` — the same permission the approval inbox routes on, for the
 * same reason its comment gives: the inbox is what somebody may *act* on, and a delegation covering
 * only `document:reject` puts nothing in it, because there is no such thing as a task you may only
 * refuse. A dashboard count derived from a different permission would be a count of tasks the inbox
 * does not show.
 */
@Injectable()
export class IdentityDashboardDelegationMetrics implements DashboardDelegationMetrics {
  constructor(
    @Inject(DELEGATION_SERVICE) private readonly delegations: DelegationService,
    @Inject(USER_DIRECTORY) private readonly directory: UserDirectory,
  ) {}

  async coveredBy(userId: UserId, at: Date): Promise<readonly UserId[]> {
    const delegators = await this.delegations.delegatorsFor({
      delegateId: userId,
      permission: Permission.DOCUMENT_APPROVE,
      at,
    });
    return delegators.map((delegation) => delegation.delegatorId);
  }

  async activeFor(userId: UserId, at: Date): Promise<readonly DashboardDelegation[]> {
    const active = await this.delegations.listActive(userId, at);
    if (active.length === 0) {
      return [];
    }

    // The other party of each arrangement, looked up once for the whole card rather than per row:
    // somebody covering three colleagues is one query, not three.
    const counterpartIds = active.map((delegation) =>
      delegation.delegatorId === userId ? delegation.delegateId : delegation.delegatorId,
    );
    const contacts = await this.directory.contactsFor([...new Set(counterpartIds)]);
    const names = new Map(
      contacts.map((contact) => [contact.userId as string, contact.displayName]),
    );

    return active.map((delegation) => {
      const given = delegation.delegatorId === userId;
      const counterpartId = given ? delegation.delegateId : delegation.delegatorId;
      return {
        id: delegation.id,
        // From the reader's point of view, always: "GIVEN" is cover this person arranged, "RECEIVED"
        // is cover they were given. A screen comparing identifiers to work this out is a screen
        // that renders the wrong label the first time an administrator reads somebody else's.
        direction: given ? ('GIVEN' as const) : ('RECEIVED' as const),
        counterpartId,
        counterpartName: names.get(counterpartId) ?? null,
        startsAt: delegation.startsAt,
        endsAt: delegation.endsAt,
      };
    });
  }
}
