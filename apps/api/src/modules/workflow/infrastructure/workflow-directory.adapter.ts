import { Inject, Injectable } from '@nestjs/common';

import { type UserId, asId } from '@edms/domain';

import { APPROVAL_ROUTING_SERVICE } from '../../administration/application/approval-routing.ports';
import type { ApprovalRoutingService } from '../../administration/application/approval-routing.service';
import { USER_DIRECTORY, type UserDirectory } from '../../identity/application/ports';
import type { RoleScope, WorkflowDirectory } from '../application/ports';

/**
 * How the engine finds people, composed from the two modules that know.
 *
 * Four of the seven participant resolver kinds are questions about *people* — role holders,
 * department members, somebody's manager, and whether an account is still usable — and those are
 * Identity's. One is a question about an approval group, and that is Administration's. Neither
 * module reads the other's tables and nor does this: every call goes through an application
 * service, which is what `02-backend-architecture.md` §3 requires and what keeps a resolver from
 * becoming a second opinion about who works here.
 *
 * There is no caching anywhere in this file, deliberately. `07-workflow-architecture.md` §2 resolves
 * participants at stage activation precisely so that an org change does not break a workflow
 * authored before it — and a cache would reintroduce exactly the staleness the design removed, with
 * the failure showing up as an approval routed to somebody who left.
 */
@Injectable()
export class WorkflowDirectoryAdapter implements WorkflowDirectory {
  constructor(
    @Inject(USER_DIRECTORY) private readonly people: UserDirectory,
    @Inject(APPROVAL_ROUTING_SERVICE) private readonly routing: ApprovalRoutingService,
  ) {}

  holdersOfRole(roleKey: string, scope: RoleScope): Promise<readonly UserId[]> {
    return this.people.holdersOfRole(roleKey, scope);
  }

  membersOfDepartment(departmentId: string, managersOnly: boolean): Promise<readonly UserId[]> {
    return this.people.membersOfDepartment(departmentId, managersOnly);
  }

  managersOf(subject: UserId): Promise<readonly UserId[]> {
    return this.people.managersOf(subject);
  }

  async membersOfGroup(groupKey: string): Promise<readonly UserId[]> {
    const members = await this.routing.membersOfGroup(groupKey);
    return members.map((userId) => asId<UserId>(userId));
  }

  activeAmong(userIds: readonly UserId[]): Promise<readonly UserId[]> {
    return this.people.activeAmong(userIds);
  }

  async displayNames(userIds: readonly UserId[]): Promise<ReadonlyMap<string, string>> {
    const contacts = await this.people.contactsFor(userIds);
    return new Map(contacts.map((contact) => [contact.userId, contact.displayName]));
  }
}
