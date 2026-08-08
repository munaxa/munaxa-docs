import { Inject, Injectable } from '@nestjs/common';

import { UserStatus, type UserId, asId } from '@edms/domain';

import type { BulkRequesterAuthority, BulkRequesterDirectory } from '../../../core/bulk/bulk.port';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { CREDENTIAL_REPOSITORY, type CredentialRepository } from '../application/ports';

/**
 * `BULK_REQUESTER_DIRECTORY`, answered by the module that owns people — Phase 6.2.
 *
 * The mirror of every other narrow port Identity implements for another module's consumer: core
 * declares what it needs, Identity answers it, and the dependency points the way that has no cycle
 * in it.
 *
 * ## Why it re-reads rather than trusting a snapshot
 *
 * A queued bulk operation runs minutes or hours after somebody asked for it. Copying their
 * permissions onto the job at enqueue time would make the job a bearer token for an authority that
 * may since have been withdrawn — somebody could queue five thousand approvals, be removed from
 * the approver role, and still have the operation spend the grant. Reading here means the
 * withdrawal takes effect on every object not yet processed.
 *
 * ## Why this is not `REPORT_SUBJECT_READER`
 *
 * Phase 15 established this exact principle for queued report exports and has a port for it —
 * *"somebody whose access was revoked between asking and running gets a smaller report … a snapshot
 * taken at request time would let a queue backlog hand out reach that had already been taken
 * away."* This is that rule, applied to a second queue, and the wording above is deliberately its
 * wording.
 *
 * It is a **different question**, though, which is why it is a second port rather than a reuse.
 * `ReportSubjectReader.rolesFor` answers role keys, because a report's reach is entirely an ACL
 * predicate. A bulk operation has two gates: the per-object ACL resolution *and* a tenant-wide
 * permission floor — `BulkApprovalService` refuses a caller holding no `document:approve` at all
 * before it opens an operation row — and that floor reads `context.permissions`, which
 * `rolesFor` does not carry. Widening Reporting's port to serve Bulk would put one module's
 * interface in the shape of another module's needs, which is what narrow ports exist to prevent.
 *
 * It reads through `CredentialRepository` because that is the interface that already assembles a
 * person's roles and their effective permission set, narrowed against the catalogue — the same
 * assembly the sign-in path uses, so a queued run and an interactive one resolve the same subject.
 *
 * **A disabled user answers null**, and the consumer fails the operation rather than running it.
 * That is the safe direction: a suspended account's queued work is exactly the work a suspension
 * is meant to stop.
 */
@Injectable()
export class BulkRequesterDirectoryAdapter implements BulkRequesterDirectory {
  constructor(
    @Inject(CREDENTIAL_REPOSITORY) private readonly credentials: CredentialRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  async currentAuthority(userId: string): Promise<BulkRequesterAuthority | null> {
    const credential = await this.unitOfWork.run(() =>
      this.credentials.findById(asId<UserId>(userId)),
    );
    if (credential === null || credential.status !== UserStatus.ACTIVE) {
      return null;
    }
    return {
      roleKeys: credential.roleKeys,
      roleIds: credential.roleIds,
      permissions: credential.permissions,
      permissionVersion: credential.permissionVersion,
    };
  }
}
