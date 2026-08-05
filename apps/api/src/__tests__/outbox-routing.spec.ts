import { describe, expect, it } from 'vitest';

import { QueueName } from '@edms/domain';

import { AUDIT_EVENT_TYPES } from '../modules/audit/domain/events';
import { DOCUMENT_EVENT_TYPES } from '../modules/document/domain/events';
import { IDENTITY_EVENT_TYPES } from '../modules/identity/domain/events';
import { LIBRARY_EVENT_TYPES } from '../modules/library/domain/events';
import { NOTIFICATION_EVENT_TYPES } from '../modules/notification/domain/events';
import { ORGANIZATION_EVENT_TYPES } from '../modules/organization/domain/events';
import { PREVIEW_EVENT_TYPES } from '../modules/preview/domain/events';
import { RETENTION_EVENT_TYPES } from '../modules/retention/domain/events';
import { REVISION_EVENT_TYPES } from '../modules/revision/domain/events';
import { STORAGE_EVENT_TYPES } from '../modules/storage/domain/events';
import { WORKFLOW_EVENT_TYPES } from '../modules/workflow/domain/events';
import { routesFor } from '../core/outbox/prisma-outbox.dispatcher';

/**
 * The routing table's safety net — and the reason Phase 12 kept a prefix match rather than
 * replacing it with a per-module registry.
 *
 * The dispatcher's own comment argued that a prefix "is derived from the aggregate name, which
 * the event type already carries, so a new event in an existing module routes correctly with no
 * change here at all". That turned out to be **false**, and this file is what would have caught
 * it: Phase 11's four events are named `delegation.*`, their aggregate is `identity`, no prefix
 * matched them, and every one was silently discarded as unroutable from the day it shipped.
 *
 * A registry would have bought detectability at the cost of a cross-module registration. These
 * assertions buy the same property for the cost of one import per module — and, unlike a
 * registry, they also state *which* lane each family is expected to reach, which no registration
 * could check.
 *
 * It lives in `src/__tests__` rather than beside the dispatcher because it imports eleven modules'
 * event catalogues, and `src/core/**` may never depend on a module — the boundary lint says so and
 * is right to. A test that asserts *across* the whole application is an application-level test,
 * which is what this directory is for.
 */

/** Every event type any module in the product publishes. */
const PUBLISHED: readonly string[] = Object.freeze([
  ...AUDIT_EVENT_TYPES,
  ...DOCUMENT_EVENT_TYPES,
  ...IDENTITY_EVENT_TYPES,
  ...LIBRARY_EVENT_TYPES,
  ...NOTIFICATION_EVENT_TYPES,
  ...ORGANIZATION_EVENT_TYPES,
  ...PREVIEW_EVENT_TYPES,
  ...RETENTION_EVENT_TYPES,
  ...REVISION_EVENT_TYPES,
  ...STORAGE_EVENT_TYPES,
  ...WORKFLOW_EVENT_TYPES,
]);

/**
 * The families that legitimately route nowhere, and why each does.
 *
 * Stated as an explicit list rather than left as "whatever does not match", so that adding an
 * event and forgetting to route it fails here — which is the whole point. A family is on this
 * list because nothing consumes it *and nothing should*, not because nothing does yet.
 */
const DELIBERATELY_UNROUTED: readonly string[] = Object.freeze([
  // Identity's own three. A user being created, disabled or re-roled changes authorisation, and
  // authorisation is read from the database on the next request rather than projected anywhere.
  'user.created',
  'user.disabled',
  'user.roles-changed',
  // Organisation and library structure. The search projection re-reads a document's placement
  // when the document changes; a folder moving does not change what any document *says*.
  'library.created',
  'library.folder-moved',
  'library.acl-changed',
  'organization.department-moved',
  'organization.node-archived',
  // Storage's other three. A file being created or scanned is announced to the preview pipeline
  // by the document or revision event that references it, and a checksum mismatch is Phase 18's
  // integrity sweep.
  'storage.file-created',
  'storage.scan-completed',
  'storage.checksum-mismatch',
]);

describe('the outbox routing table', () => {
  it('routes every event type some module publishes, or names it as deliberately unrouted', () => {
    const orphans = PUBLISHED.filter(
      (eventType) =>
        routesFor(eventType).length === 0 && !DELIBERATELY_UNROUTED.includes(eventType),
    );

    // This is the assertion Phase 11's `delegation.*` events would have failed.
    expect(orphans).toEqual([]);
  });

  it('sends every family 18 §4 names to the notification lane', () => {
    const addressedToPeople = [
      'workflow.task-assigned',
      'workflow.reminder-due',
      'workflow.overdue',
      'document.approved',
      'document.rejected',
      'document.published',
      'document.checked-out',
      'document.checked-in',
      'delegation.requested',
      'delegation.approved',
      'delegation.revoked',
      'delegation.expired',
      'retention.due',
      'retention.hold-placed',
      'retention.hold-released',
      'audit.chain-broken',
      'storage.file-quarantined',
    ];

    for (const eventType of addressedToPeople) {
      expect(routesFor(eventType), eventType).toContain(QueueName.NOTIFICATIONS_DELIVER);
    }
  });

  it('keeps the search projection fed by everything that changes what a document says', () => {
    for (const eventType of ['document.created', 'document.moved', 'revision.published']) {
      expect(routesFor(eventType), eventType).toContain(QueueName.SEARCH_INDEX);
    }
  });

  it('does not notify twice about one publication', () => {
    // A revision being published and the document being published are one act. `document.published`
    // is the row 18 §4 names, so it is the one that carries the notification.
    expect(routesFor('revision.published')).not.toContain(QueueName.NOTIFICATIONS_DELIVER);
  });

  it('routes an event nothing publishes nowhere, rather than guessing', () => {
    expect(routesFor('invented.event')).toEqual([]);
  });
});
