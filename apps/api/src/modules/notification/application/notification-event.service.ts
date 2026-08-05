import { Inject, Injectable } from '@nestjs/common';

import { type DocumentId, type UserId, Permission, Settings, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { DOCUMENT_SERVICE, type DocumentService } from '../../document/application/ports';
import { USER_DIRECTORY, type UserDirectory } from '../../identity/application/ports';
import { NotificationType } from '../domain/notification-types';
import {
  NOTIFICATION_BATCH_REPOSITORY,
  NOTIFICATION_SERVICE,
  type NotificationBatchRepository,
  type NotificationService,
} from './notification.ports';
import { RecipientVisibilityService } from './recipient-visibility.service';

/**
 * The consumer's use case: one outbox event in, notifications out.
 *
 * This is the class Phase 4, 9, 10 and 11 were each waiting for. Every one of them said the same
 * sentence — "the outbox row is the record until a consumer exists" — and this is the consumer.
 *
 * ## Its shape is a switch, and that is deliberate
 *
 * Each event answers three questions differently: **who** hears about it, **what** the template's
 * placeholders mean, and whether it is one of the bulk families that must be coalesced. Those
 * three answers belong together — a recipient list and the values that describe them to those
 * recipients are one decision — and separating the routing half into the modules that publish
 * the events is the registry the outbox dispatcher's comment argues against.
 *
 * ## Recipients are ACL-filtered wherever a document is involved
 *
 * Through `RecipientVisibilityService`, which is the phase's named risk and its answer: a
 * notification that tells somebody a document exists is a disclosure even when the link then
 * refuses them (18 §8). Recipient lists with no document behind them — the two parties to a
 * delegation, an administrator told an address was suppressed — are not filtered, because there
 * is no object to resolve and 18 §4 names those people by their relationship to the event.
 *
 * ## Idempotency is the outbox row's identifier
 *
 * `notify` keys on `(eventId, recipient, channel)` and the event id passed here is the outbox
 * row's own. A redelivered job therefore produces nothing, which is the assertion the integration
 * suite makes: an event consumed once produces one message per recipient and channel, and the
 * same event redelivered produces none.
 */
@Injectable()
export class NotificationEventService {
  constructor(
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationService,
    @Inject(NOTIFICATION_BATCH_REPOSITORY) private readonly batches: NotificationBatchRepository,
    @Inject(DOCUMENT_SERVICE) private readonly documents: DocumentService,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly visibility: RecipientVisibilityService,
  ) {}

  /**
   * Handles one delivered outbox event.
   *
   * Returns how many messages it produced, so a consumer can log something useful and a test can
   * assert on it. An event this phase does not translate returns zero and is not an error: most
   * of what reaches this lane rides a prefix — `audit.chain-verified` beside `audit.chain-broken`
   * — and dropping those is cheaper than a per-event routing table.
   */
  async handle(input: {
    readonly eventId: string;
    readonly eventType: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }): Promise<number> {
    return this.unitOfWork.run(async () => {
      const created = await this.translate(input.eventId, input.eventType, input.payload);
      return created;
    });
  }

  private async translate(
    eventId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<number> {
    switch (eventType) {
      case 'workflow.task-assigned':
        return this.approvalTask(eventId, payload, NotificationType.APPROVAL_TASK_ASSIGNED.key);
      case 'workflow.reminder-due':
        return this.approvalTask(
          eventId,
          payload,
          NotificationType.APPROVAL_DEADLINE_APPROACHING.key,
        );
      case 'workflow.overdue':
        return this.approvalTask(eventId, payload, NotificationType.APPROVAL_OVERDUE.key);
      case 'workflow.task-escalated':
        return this.escalation(eventId, payload);

      case 'document.approved':
        return this.documentEvent(eventId, payload, NotificationType.DOCUMENT_APPROVED.key, {});
      case 'document.rejected':
        return this.documentEvent(eventId, payload, NotificationType.DOCUMENT_REJECTED.key, {
          comment: asString(payload['comment']) ?? '—',
        });
      case 'document.published':
        return this.documentEvent(eventId, payload, NotificationType.DOCUMENT_PUBLISHED.key, {});
      case 'document.checked-out':
        return this.checkedOut(eventId, payload);
      case 'document.checked-in':
        return this.documentEvent(eventId, payload, NotificationType.DOCUMENT_CHECKED_IN.key, {
          revisionLabel: asNumber(payload['ordinal'])?.toString() ?? '—',
        });

      case 'delegation.requested':
        return this.delegationEvent(eventId, payload, NotificationType.DELEGATION_REQUESTED.key);
      case 'delegation.approved':
        return this.delegationEvent(eventId, payload, NotificationType.DELEGATION_APPROVED.key);
      case 'delegation.revoked':
        return this.delegationEvent(eventId, payload, NotificationType.DELEGATION_REVOKED.key);
      case 'delegation.expired':
        return this.delegationEvent(eventId, payload, NotificationType.DELEGATION_EXPIRED.key);

      case 'retention.due':
        return this.retentionDue(payload);
      case 'retention.hold-placed':
        return this.documentEvent(eventId, payload, NotificationType.LEGAL_HOLD_PLACED.key, {
          reason: asString(payload['reason']) ?? '—',
        });
      case 'retention.hold-released':
        return this.documentEvent(eventId, payload, NotificationType.LEGAL_HOLD_RELEASED.key, {});

      case 'audit.chain-broken':
        return this.chainBroken(eventId, payload);
      case 'storage.file-quarantined':
        return this.quarantined(eventId, payload);

      default:
        return 0;
    }
  }

  // --- Workflow ------------------------------------------------------------------------------

  /**
   * Assignment, reminder and overdue: three types, one recipient rule.
   *
   * The assignees are what the event carries, and they are ACL-filtered anyway. Holding an
   * approval task is not the same as being able to read the document — a task assigned before
   * somebody was moved out of a folder outlives the permission that justified it, and telling
   * them the document's number and title would be the disclosure §8 forbids.
   */
  private async approvalTask(
    eventId: string,
    payload: Readonly<Record<string, unknown>>,
    typeKey: string,
  ): Promise<number> {
    const documentId = asDocumentId(payload['documentId']);
    const assignees = asUserIds(payload['assigneeIds']);
    if (documentId === null || assignees.length === 0) {
      return 0;
    }
    const document = await this.documents.get(documentId);
    if (document === null) {
      return 0;
    }
    const recipients = await this.visibility.whoMaySee(assignees, documentId);

    const created = await this.notifications.notify({
      eventId,
      typeKey,
      recipientIds: recipients,
      values: {
        documentTitle: document.title,
        documentNumber: document.documentNumber ?? '—',
        documentLink: this.documentLink(documentId),
        stageName: asString(payload['stageName']) ?? '—',
        dueAt: asString(payload['dueAt']) ?? '—',
      },
    });
    return created.length;
  }

  /**
   * A deadline passed and the task moved — 18 §4's "assignee + escalation target".
   *
   * The person it moved *to* is told they have an approval; the person it moved *from* is told it
   * is overdue rather than that it was taken away, because `keepOriginal` defaults to true and
   * they may still decide it.
   */
  private async escalation(
    eventId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<number> {
    const documentId = asDocumentId(payload['documentId']);
    const to = asUserId(payload['toAssigneeId']);
    const from = asUserId(payload['fromAssigneeId']);
    if (to === null) {
      return 0;
    }
    if (documentId === null) {
      // `workflow.task-escalated` carries the task rather than the document, and resolving one to
      // the other would mean reading Workflow's aggregate from here. The escalation target hears
      // about it through the `workflow.task-assigned` the reopened stage publishes; this branch
      // exists so the event is recognised rather than logged as unhandled every time one fires.
      return 0;
    }
    const recipients = await this.visibility.whoMaySee(
      from === null ? [to] : [to, from],
      documentId,
    );
    const document = await this.documents.get(documentId);
    if (document === null) {
      return 0;
    }
    const created = await this.notifications.notify({
      eventId,
      typeKey: NotificationType.APPROVAL_OVERDUE.key,
      recipientIds: recipients,
      values: {
        documentTitle: document.title,
        documentNumber: document.documentNumber ?? '—',
        documentLink: this.documentLink(documentId),
        stageName: '—',
        dueAt: asString(payload['dueAt']) ?? '—',
      },
    });
    return created.length;
  }

  // --- Document ------------------------------------------------------------------------------

  /**
   * 18 §4's "Author, owner, watchers".
   *
   * The first two exist; **watchers and subscribers do not**. There is no subscription model in
   * this product, and inventing one to satisfy a row would be building the capability rather than
   * notifying about it — the report records it as a deliberate limit and names the phase that
   * would unblock it. What is here is the owner and whoever created the record, which is the
   * whole of "the people this document belongs to" as the data model currently states it.
   */
  private async documentEvent(
    eventId: string,
    payload: Readonly<Record<string, unknown>>,
    typeKey: string,
    extraValues: Readonly<Record<string, string>>,
  ): Promise<number> {
    const documentId = asDocumentId(payload['documentId']);
    if (documentId === null) {
      return 0;
    }
    const document = await this.documents.get(documentId);
    if (document === null) {
      return 0;
    }
    const interested = [document.ownerUserId, ...asUserIds([document.createdBy])];
    const recipients = await this.visibility.whoMaySee(interested, documentId);

    const created = await this.notifications.notify({
      eventId,
      typeKey,
      recipientIds: recipients,
      values: {
        documentTitle: document.title,
        documentNumber: document.documentNumber ?? '—',
        documentLink: this.documentLink(documentId),
        ...extraValues,
      },
    });
    return created.length;
  }

  /**
   * §4's `CheckedOutByOther`, read literally: the notification is for everybody with an interest
   * *other than* the person who took the lock.
   *
   * Telling somebody they have checked a document out is telling them what they just did.
   */
  private async checkedOut(
    eventId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<number> {
    const documentId = asDocumentId(payload['documentId']);
    const lockedBy = asUserId(payload['lockedBy']);
    if (documentId === null) {
      return 0;
    }
    const document = await this.documents.get(documentId);
    if (document === null) {
      return 0;
    }
    const interested = [document.ownerUserId, ...asUserIds([document.createdBy])].filter(
      (userId) => userId !== lockedBy,
    );
    const recipients = await this.visibility.whoMaySee(interested, documentId);

    const created = await this.notifications.notify({
      eventId,
      typeKey: NotificationType.DOCUMENT_CHECKED_OUT.key,
      recipientIds: recipients,
      values: {
        documentTitle: document.title,
        documentNumber: document.documentNumber ?? '—',
        documentLink: this.documentLink(documentId),
        expiresAt: asString(payload['expiresAt']) ?? '—',
      },
    });
    return created.length;
  }

  // --- Delegation ----------------------------------------------------------------------------

  /**
   * Phase 11's four events, delivered — the row its report left owing.
   *
   * **Not ACL-filtered**, and that is a decision rather than an omission. A delegation names two
   * people and concerns no document; there is no object to resolve, and §4's row names the
   * delegate and the delegator because the arrangement is *theirs*. A request additionally goes
   * to whoever may agree to it, which the event carries because Phase 11 resolved it when the
   * request was made — reading the reporting line again here would answer about the org chart as
   * it is now rather than as it was when somebody asked.
   */
  private async delegationEvent(
    eventId: string,
    payload: Readonly<Record<string, unknown>>,
    typeKey: string,
  ): Promise<number> {
    const delegatorId = asUserId(payload['delegatorId']);
    const delegateId = asUserId(payload['delegateId']);
    if (delegatorId === null || delegateId === null) {
      return 0;
    }
    const parties = await this.users.contactsFor([delegatorId, delegateId]);
    const nameOf = (userId: UserId): string =>
      parties.find((contact) => contact.userId === userId)?.displayName ?? '—';

    const recipients =
      typeKey === NotificationType.DELEGATION_REQUESTED.key
        ? // Addressed to whoever must agree, not to the two parties: nothing is in force yet, and
          // telling a delegate about cover that may be declined is telling them about a decision
          // that has not been taken.
          asUserIds(payload['approverIds'])
        : [delegatorId, delegateId];

    const created = await this.notifications.notify({
      eventId,
      typeKey,
      recipientIds: recipients,
      values: {
        delegatorName: nameOf(delegatorId),
        delegateName: nameOf(delegateId),
        startsAt: asString(payload['startsAt']) ?? '—',
        endsAt: asString(payload['endsAt']) ?? '—',
        reason: asString(payload['reason']) ?? '—',
        useCount: (asNumber(payload['useCount']) ?? 0).toString(),
        delegationLink: `${this.config.mail.webBaseUrl}/delegations`,
      },
    });
    return created.length;
  }

  // --- Retention -----------------------------------------------------------------------------

  /**
   * Phase 10's "no disposition-review reminder" row, discharged — **coalesced**.
   *
   * This is 18 §7's last row in practice. A nightly sweep settling five hundred schedules
   * publishes five hundred `retention.due` events, and the idempotency key does nothing about
   * them: it prevents duplicates of *one* event and these are five hundred distinct ones. So no
   * notification is sent here at all. The event increments a window instead, and one summary goes
   * out when the window closes — "412 documents are due for retention review" — which is the only
   * form of this message anybody would read.
   *
   * The window key is the tenant's day rather than a sweep identifier, because the sweep has no
   * identifier: `retention.due` is published by whichever pass finds a schedule due, and two
   * passes on one day are one fact to a controller.
   */
  private async retentionDue(payload: Readonly<Record<string, unknown>>): Promise<number> {
    const documentId = asDocumentId(payload['documentId']);
    if (documentId === null) {
      return 0;
    }
    // Addressed to a capability rather than to a role name, so a tenant that renames its
    // controller role keeps being told. `retention:manage` is 08 §6's grant for exactly this.
    const controllers = await this.users.holdersOfPermission(Permission.RETENTION_MANAGE);
    if (controllers.length === 0) {
      this.logger.warn('A retention schedule is due with nobody holding retention:manage');
      return 0;
    }

    const minutes = await this.settings.get(Settings.NOTIFICATION_COALESCE_MINUTES);
    const now = this.clock.now();
    await this.batches.accumulate({
      key: `retention-due:${now.toISOString().slice(0, 10)}`,
      typeKey: NotificationType.RETENTION_REVIEW_DUE.key,
      recipientIds: controllers,
      values: { reviewLink: `${this.config.mail.webBaseUrl}/admin/retention` },
      releaseAt: new Date(now.getTime() + minutes * 60_000),
    });
    // Nothing is sent yet, and that is the answer rather than a shortfall. `releaseBatches`
    // produces the one summary this window is for.
    return 0;
  }

  /**
   * Emits one summary per closed coalescing window.
   *
   * Called by the consumer on its schedule. The batch rows are deleted as they are claimed, in
   * the same transaction, so a redelivered release finds nothing rather than sending twice.
   */
  async releaseBatches(limit: number): Promise<number> {
    return this.unitOfWork.run(async () => {
      const closed = await this.batches.claimClosed(this.clock.now(), limit);
      let sent = 0;
      for (const batch of closed) {
        const created = await this.notifications.notify({
          // Deterministic from the window, so a redelivery that somehow re-created the row still
          // cannot produce a second summary.
          eventId: `batch:${batch.key}:${String(batch.releaseAt.getTime())}`,
          typeKey: batch.typeKey,
          recipientIds: batch.recipientIds,
          values: { ...batch.values, documentCount: String(batch.itemCount) },
        });
        sent += created.length;
      }
      return sent;
    });
  }

  // --- Security and operations ---------------------------------------------------------------

  /**
   * Phase 9's undelivered chain-broken alert, delivered.
   *
   * Its recipient is an **operator** rather than an ordinary tenant user, and the honest position
   * on that is worth stating: this product has no operator channel. ADR-0013 puts cross-tenant
   * operations in a separate console, and that console does not exist. So the alert goes to the
   * people inside the tenant who hold `audit:view` — the tenant administrator, the document
   * controller and the auditor, per 08 §6 — which is the closest thing to an operator this
   * deployment has, and is anyway who a compliance incident is escalated to.
   *
   * The weakness is real and named in the report: if the tenant's own trail is broken by somebody
   * inside the tenant, the alert goes to a set of people that may include them.
   */
  private async chainBroken(
    eventId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<number> {
    const operators = await this.users.holdersOfPermission(Permission.AUDIT_VIEW);
    if (operators.length === 0) {
      this.logger.error('The audit chain is broken and nobody holds audit:view');
      return 0;
    }
    const created = await this.notifications.notify({
      eventId,
      typeKey: NotificationType.AUDIT_CHAIN_BROKEN.key,
      recipientIds: operators,
      values: {
        occurredAt: this.clock.now().toISOString(),
        reason: asString(payload['reason']) ?? 'UNKNOWN',
        auditLink: `${this.config.mail.webBaseUrl}/audit`,
      },
    });
    return created.length;
  }

  /** 18 §4's "infected upload": the person who uploaded it, and the administrators. */
  private async quarantined(
    eventId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<number> {
    const administrators = await this.users.holdersOfPermission(Permission.USER_MANAGE);
    const uploader = asUserId(payload['uploadedBy']);
    const recipients = uploader === null ? administrators : [uploader, ...administrators];
    if (recipients.length === 0) {
      return 0;
    }
    const created = await this.notifications.notify({
      eventId,
      typeKey: NotificationType.SECURITY_FILE_QUARANTINED.key,
      recipientIds: recipients,
      values: {
        filename: asString(payload['filename']) ?? 'an uploaded file',
        occurredAt: this.clock.now().toISOString(),
        verdict: asString(payload['verdict']) ?? asString(payload['reason']) ?? 'infected',
      },
    });
    return created.length;
  }

  /**
   * Where a notification's deep link points.
   *
   * §4: "a notification carries a deep link and enough context to act". It grants nothing — the
   * route behind it resolves through ordinary authorisation like every other, which is §8's third
   * prohibition — and it is built from configuration rather than guessed from a request, because
   * a queue consumer has no request behind it to guess from.
   */
  private documentLink(documentId: DocumentId): string {
    return `${this.config.mail.webBaseUrl}/documents/${documentId}`;
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asUserId(value: unknown): UserId | null {
  return typeof value === 'string' && value.length > 0 ? asId<UserId>(value) : null;
}

function asDocumentId(value: unknown): DocumentId | null {
  return typeof value === 'string' && value.length > 0 ? asId<DocumentId>(value) : null;
}

function asUserIds(value: unknown): readonly UserId[] {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map((entry) => asId<UserId>(entry));
}
