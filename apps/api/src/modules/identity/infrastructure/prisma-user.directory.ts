import { Injectable } from '@nestjs/common';

import { type UserId, asId } from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import type { UserContact, UserDirectory } from '../application/ports';

/**
 * Recipient lookup for other modules.
 *
 * Deleted and never-activated users are excluded: an invitation that was withdrawn is not an
 * address the product should still be writing to, and a deleted user's mailbox may belong to
 * somebody else by now.
 */
@Injectable()
export class PrismaUserDirectory implements UserDirectory {
  async contactFor(userId: UserId): Promise<UserContact | null> {
    const [contact] = await this.contactsFor([userId]);
    return contact ?? null;
  }

  async contactsFor(userIds: readonly UserId[]): Promise<readonly UserContact[]> {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await requireTransaction().user.findMany({
      where: { id: { in: [...userIds] }, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, email: true, displayName: true },
    });
    return rows.map((row) => ({
      userId: asId<UserId>(row.id),
      email: row.email,
      displayName: row.displayName,
    }));
  }
}
