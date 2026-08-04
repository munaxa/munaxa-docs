import { Inject, Injectable } from '@nestjs/common';

import { type UserId } from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { CLOCK_PORT, type ClockPort } from '../../ports/clock.port';
import { requireContext } from '../tenancy/tenant-context';

/**
 * Who did it, and when — as one object a repository spreads into a write.
 *
 * Eighteen administered resources carry the same six columns, and every one of them can be got
 * subtly wrong in the same way: `updatedBy` left off an update, `deletedBy` set without
 * `deletedAt`, a second `new Date()` a few milliseconds after the first so a row's `createdAt`
 * and `updatedAt` disagree about when it was created. None of those fail a test that is not
 * looking for them, and all of them corrupt the evidence a document-control system exists to
 * produce.
 *
 * So the stamps come from here, from the injected clock, in one reading per operation.
 *
 * Actorship is read from the ambient request context rather than passed in. It is the same
 * reasoning as the tenant: a parameter can be forgotten at one call site out of two hundred, and
 * `created_by` is never inferred at read time (`05-database-design.md` §1).
 */
@Injectable()
export class RecordStamps {
  constructor(@Inject(CLOCK_PORT) private readonly clock: ClockPort) {}

  /**
   * A fresh identifier, time-ordered from the same clock.
   *
   * Here rather than at each call site so that a test which freezes time gets deterministic
   * identifiers too — and because `uuidv7()` defaulting to `Date.now()` is exactly the hidden
   * clock read that injecting a clock is meant to remove.
   */
  nextId(): string {
    return uuidv7(this.clock.now().getTime());
  }

  /**
   * The stamps for a new row.
   *
   * `createdAt` is stated rather than left to the column default, so that it is the *same*
   * instant as `updatedAt` and as any audit event written beside it. A default of `now()` is the
   * transaction's clock, not the application's, and the two differ by however long the
   * transaction had been open.
   */
  creation(): {
    readonly createdAt: Date;
    readonly createdBy: string | null;
    readonly updatedAt: Date;
    readonly updatedBy: string | null;
  } {
    const at = this.clock.now();
    const by = this.actor();
    return { createdAt: at, createdBy: by, updatedAt: at, updatedBy: by };
  }

  /** The stamps for a change. `updatedAt` is set explicitly, not left to `@updatedAt`. */
  update(): { readonly updatedAt: Date; readonly updatedBy: string | null } {
    return { updatedAt: this.clock.now(), updatedBy: this.actor() };
  }

  /**
   * The stamps for a soft delete.
   *
   * `updatedAt` and `updatedBy` move too: a delete is a change to the row, and a recycle bin
   * sorted by "last changed" that ignored deletions would put the thing you just deleted at the
   * bottom.
   */
  deletion(): {
    readonly deletedAt: Date;
    readonly deletedBy: string | null;
    readonly updatedAt: Date;
    readonly updatedBy: string | null;
  } {
    const at = this.clock.now();
    const by = this.actor();
    return { deletedAt: at, deletedBy: by, updatedAt: at, updatedBy: by };
  }

  /** The stamps for a restore. Both delete columns are cleared; leaving one is a half-live row. */
  restoration(): {
    readonly deletedAt: null;
    readonly deletedBy: null;
    readonly updatedAt: Date;
    readonly updatedBy: string | null;
  } {
    return { deletedAt: null, deletedBy: null, ...this.update() };
  }

  now(): Date {
    return this.clock.now();
  }

  /**
   * The acting user, or null when the system acted alone.
   *
   * Null is a real answer rather than a gap — provisioning creates the first rows before any user
   * exists — which is why every actor column is nullable and why this does not throw.
   */
  private actor(): UserId | null {
    return requireContext().userId;
  }
}
