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
import { webhookSubscribes } from '@edms/domain';

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

  /**
   * Phase 17's change, and the reason the assertion below reverses.
   *
   * The table's default was `[]`, which is what made forgetting a family *silent*: `delegation.*`
   * routed nowhere from Phase 11 until Phase 12 found it, and `library.*` until Phase 14. For
   * every consumer before this one the consequence was partial — some re-projections missed, some
   * messages missed — and somebody eventually noticed a document was not findable.
   *
   * A webhook subscriber has no such signal. An integration built on "tell me when anything
   * happens" that silently receives nothing from one family cannot discover the gap at all,
   * because absence is indistinguishable from quiet. So the default is now the webhook lane, and
   * the next phase that adds an event family gets webhooks without touching `routesFor`.
   */
  it('routes an event nothing publishes to the webhook lane rather than nowhere', () => {
    expect(routesFor('invented.event')).toEqual([QueueName.WEBHOOKS_DELIVER]);
  });

  it('sends every family — including the deliberately unrouted ones — to the webhook lane', () => {
    // The assertion that makes "a webhook subscriber wants everything" true rather than intended.
    // It covers `DELIBERATELY_UNROUTED` as well, because those are unrouted *for the search index
    // and the notification lane*: a `library.acl-changed` that reaches no integration is still a
    // fact an integration asked to be told about.
    for (const eventType of PUBLISHED) {
      expect(routesFor(eventType), eventType).toContain(QueueName.WEBHOOKS_DELIVER);
    }
  });

  it('narrows per endpoint rather than in this table', () => {
    // The table sends everything; `webhookSubscribes` decides what each endpoint receives. That
    // keeps the narrowing where an administrator can change it without a release, and keeps this
    // function from being the place a family goes missing for a third time.
    expect(webhookSubscribes(['document'], 'document.published')).toBe(true);
    expect(webhookSubscribes(['document'], 'library.acl-changed')).toBe(false);
  });
});
