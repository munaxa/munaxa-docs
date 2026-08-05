import { Inject, Injectable } from '@nestjs/common';

import type { UserId } from '@edms/domain';

import { NotFoundError } from '../../../core/errors/application-errors';
import { AdministeredWriter } from '../../../core/persistence';
import { requireVersion } from '../../../core/persistence/optimistic-lock';
import { requireContext } from '../../../core/tenancy/tenant-context';
import {
  RECENT_SEARCH_REPOSITORY,
  SAVED_SEARCH_REPOSITORY,
  type RecentSearchRecord,
  type RecentSearchRepository,
  type SavedSearchRecord,
  type SavedSearchRepository,
} from './ports';
import { APP_CONFIG, type AppConfig } from '../../../core/config';

/**
 * Saved and recent searches — one person's shortcuts.
 *
 * Not audited, for the reason favourites are not (`document.service.ts`): the audit trail is
 * evidence about controlled records, and what somebody named a query is a fact about a menu.
 * The writes still ride the unit of work, so a rename and its optimistic-lock bump commit
 * together.
 *
 * Ownership is the entire permission model here: every operation resolves against the
 * caller's own rows, and somebody else's saved search answers as nonexistent — not forbidden,
 * because a saved-search id is not something another user should learn is real. Sharing by
 * ACL is the phase design's own bullet (`12-search-architecture.md` §5) and waits for the
 * phase that builds ACL entries; a sharing model invented before grants exist would be a
 * second permission system.
 */
@Injectable()
export class SavedSearchService {
  constructor(
    @Inject(SAVED_SEARCH_REPOSITORY) private readonly saved: SavedSearchRepository,
    @Inject(RECENT_SEARCH_REPOSITORY) private readonly recents: RecentSearchRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly writer: AdministeredWriter,
  ) {}

  async list(): Promise<readonly SavedSearchRecord[]> {
    return this.writer.read(() => this.saved.listFor(this.actor()));
  }

  async create(input: {
    readonly name: string;
    readonly query: string;
    readonly filters: Readonly<Record<string, readonly string[]>>;
  }): Promise<SavedSearchRecord> {
    return this.writer.read(async () => {
      const id = this.writer.clock.nextId();
      await this.saved.create({ id, ownerId: this.actor(), ...input });
      return this.requireOwn(id);
    });
  }

  async update(
    id: string,
    expectedVersion: number | undefined,
    changes: {
      readonly name?: string;
      readonly query?: string;
      readonly filters?: Readonly<Record<string, readonly string[]>>;
    },
  ): Promise<SavedSearchRecord> {
    return this.writer.read(async () => {
      const current = await this.requireOwn(id);
      requireVersion(expectedVersion, current.version);
      await this.saved.update(id, current.version, changes);
      return this.requireOwn(id);
    });
  }

  async remove(id: string, expectedVersion: number | undefined): Promise<void> {
    await this.writer.read(async () => {
      const current = await this.requireOwn(id);
      requireVersion(expectedVersion, current.version);
      await this.saved.softDelete(id, current.version);
    });
  }

  async recent(): Promise<readonly RecentSearchRecord[]> {
    return this.writer.read(() =>
      this.recents.listFor(this.actor(), this.config.search.recentLimit),
    );
  }

  private async requireOwn(id: string): Promise<SavedSearchRecord> {
    const record = await this.saved.findById(id);
    if (record === null || record.ownerId !== this.actor()) {
      throw new NotFoundError('The requested resource');
    }
    return record;
  }

  private actor(): UserId {
    const { userId } = requireContext();
    if (userId === null) {
      throw new NotFoundError('The requested resource');
    }
    return userId;
  }
}
