import type { ReactNode } from 'react';

import type { Collection, Delegation, DelegationDirection, User } from '@edms/contracts';
import { Permission } from '@edms/domain';

import { AdminForbidden } from '../../../features/admin-shared';
import { DelegationsScreen } from '../../../features/delegations/delegations-screen';
import { adminAccess, adminGet } from '../../../lib/admin/api';

type RawSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

const DIRECTIONS: readonly DelegationDirection[] = ['GIVEN', 'RECEIVED', 'AWAITING_MY_APPROVAL'];

/**
 * Delegations — the half of `16-frontend-architecture.md` §2's `inbox/` that Phase 4 did not build.
 *
 * Gated on `delegation:manage`, which 08 §6 marks `own` for authors and approvers: holding it is
 * what lets somebody arrange their *own* cover, and the API enforces the subject by never putting
 * a delegator on the wire. So the gate here is a courtesy over an endpoint that would refuse
 * anyway — the ordinary arrangement in this product, and the reason hiding a link is never a
 * control.
 *
 * Reads happen here, in a server component, and writes go through server actions in the feature.
 * The direction is a search parameter rather than component state, so a filtered view is a link.
 */
export default async function DelegationsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}): Promise<ReactNode> {
  const access = await adminAccess(Permission.DELEGATION_MANAGE);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  const params = await searchParams;
  const raw = params['direction'];
  const asked = typeof raw === 'string' ? raw : raw?.[0];
  const direction: DelegationDirection = DIRECTIONS.includes(asked as DelegationDirection)
    ? (asked as DelegationDirection)
    : 'GIVEN';

  const query = new URLSearchParams({ page: '1', pageSize: '50', direction });
  // The register rather than the working list, for the two tabs that are about history as much as
  // about what is in force. §4's visibility rule is served by seeing what *was* in place, and a
  // list that hid every ended delegation would answer "who covered for me in March" with nothing.
  if (direction !== 'AWAITING_MY_APPROVAL') {
    query.set('includeEnded', 'true');
  }

  const [delegations, people] = await Promise.all([
    adminGet<Collection<Delegation>>(`/delegations?${query.toString()}`),
    // Who this person could delegate to. Read from the same administered list the workflow
    // screens use, rather than a directory endpoint of its own.
    // 100, the API's maximum. This asked for 200, which the pagination schema *rejects*, so the
    // request 422'd and the page threw before rendering — the third screen with this defect, after
    // the two Phase 6.6 found. Nothing caught it because nothing had opened the built application.
    adminGet<Collection<User>>('/admin/users?page=1&pageSize=100&status=ACTIVE'),
  ]);

  return (
    <DelegationsScreen
      delegations={delegations.data}
      direction={direction}
      people={people.data.map((user) => ({ id: user.id, name: user.displayName }))}
      permissions={access.permissions}
    />
  );
}
