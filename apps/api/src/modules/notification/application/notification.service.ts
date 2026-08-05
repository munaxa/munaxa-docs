import { Inject, Injectable } from '@nestjs/common';

import {
  type DigestFrequencyKey,
  type NotificationChannelKey,
  type NotificationMessageId,
  type UserId,
  AVAILABLE_NOTIFICATION_CHANNELS,
  DeliveryState,
  DigestFrequency,
  NotificationChannel,
  Settings,
  asId,
} from '@edms/domain';
import { type Page, uuidv7 } from '@edms/utils';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import {
  USER_DIRECTORY,
  type UserContact,
  type UserDirectory,
} from '../../identity/application/ports';
import { defaultTemplate } from '../domain/default-templates';
import { digestWindowEnd } from '../domain/digest';
import { type Branding, wrapEmailHtml } from '../domain/email-layout';
import {
  type NotificationTypeDefinition,
  type RecipientPreference,
  channelsFor,
  mayBeHeldForQuietHours,
  notificationTypeFor,
  shouldSendImmediately,
} from '../domain/notification-types';
import { releaseAfterQuietHours } from '../domain/quiet-hours';
import { renderMessage } from '../domain/template';
import {
  NOTIFICATION_MESSAGE_REPOSITORY,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_SUPPRESSION_REPOSITORY,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  type InboxQuery,
  type NotificationMessageRecord,
  type NotificationMessageRepository,
  type NotificationPreferenceRepository,
  type NotificationService,
  type NotificationSuppressionRepository,
  type NotificationTemplateRepository,
  type NotifyCommand,
} from './notification.ports';

/**
 * Turning "this happened" into "these people were told".
 *
 * The sender names a *type* and supplies values. It does not choose a channel, a language or a
 * template: the recipient's preferences decide the channel, the tenant decides the language,
 * and the template is data (`docs/architecture/18-notification-architecture.md` §1).
 *
 * Everything is written inside the caller's transaction. A notification about a change that
 * then rolls back is a lie the recipient cannot check, so the two commit together or not at
 * all — the same rule the audit trail follows, for the same reason.
 *
 * Nothing is delivered here. This produces `QUEUED` and `HELD` rows; `DeliveryService` sends
 * them and `DigestService` collects them. In-app notifications are the exception by nature: the
 * row *is* the delivery, which is why a mail outage never affects them (§7).
 *
 * ## What Phase 12 added, and where each decision lives
 *
 * **Suppression is checked before a row is created, not before it is sent.** An address the
 * tenant has stopped writing to produces a `SUPPRESSED` message rather than no message at all,
 * because §8's last prohibition is "silently dropped on failure" — and a notification that was
 * never attempted because the address is dead is a fact somebody has to be able to find.
 *
 * **Quiet hours and digests both produce `HELD`, and they compose.** A message caught by both is
 * held until the *later* of the two windows: a digest that arrived at 03:00 would defeat the
 * quiet hours it was collected under.
 *
 * **In-app is never held.** §3 calls it "the authoritative inbox: every notification lands here
 * regardless of other channels". Quiet hours are about being interrupted, and a row in an inbox
 * nobody is looking at interrupts nobody; a digest exists to replace a stream of *emails*.
 */
@Injectable()
export class DefaultNotificationService implements NotificationService {
  constructor(
    @Inject(NOTIFICATION_MESSAGE_REPOSITORY)
    private readonly messages: NotificationMessageRepository,
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly preferences: NotificationPreferenceRepository,
    @Inject(NOTIFICATION_TEMPLATE_REPOSITORY)
    private readonly templates: NotificationTemplateRepository,
    @Inject(NOTIFICATION_SUPPRESSION_REPOSITORY)
    private readonly suppressions: NotificationSuppressionRepository,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async notify(command: NotifyCommand): Promise<readonly NotificationMessageId[]> {
    const definition = notificationTypeFor(command.typeKey);
    if (!definition) {
      // A type outside the catalogue is a programming error, not a runtime condition: nothing
      // can render it, nobody can turn it off, and no screen can name it.
      throw new Error(`'${command.typeKey}' is not a notification type this product defines.`);
    }

    // Deduplicated before the directory is asked. A recipient list computed from an event — an
    // author who is also the owner, a delegator who is also an approver — legitimately names the
    // same person twice, and telling them twice about one fact is the volume problem §1's fifth
    // principle is about. The idempotency key would catch it, at the cost of a wasted render.
    const recipientIds = [...new Set(command.recipientIds)];
    const contacts = await this.users.contactsFor(recipientIds);
    if (contacts.length === 0) {
      return [];
    }

    const locale = await this.settings.get(Settings.DEFAULT_LOCALE);
    const timezone = await this.settings.get(Settings.TIMEZONE);
    const digestHour = await this.settings.get(Settings.NOTIFICATION_DIGEST_HOUR);
    const branding = await this.brandingFor();
    const created: NotificationMessageId[] = [];

    for (const contact of contacts) {
      const preference = await this.preferences.findFor(contact.userId, definition.key);
      const channels = channelsFor(definition, preference, AVAILABLE_NOTIFICATION_CHANNELS);
      const quietHours =
        channels.length > 0 && mayBeHeldForQuietHours(definition)
          ? await this.preferences.findQuietHours(contact.userId)
          : null;

      for (const channel of channels) {
        const id = await this.createMessage({
          command,
          definition,
          contact,
          channel,
          locale,
          branding,
          hold:
            channel === NotificationChannel.IN_APP
              ? { releaseAt: null, digestWindow: null }
              : this.holdFor(definition, preference, quietHours, timezone, digestHour),
        });
        if (id) {
          created.push(id);
        }
      }
    }
    return created;
  }

  inbox(recipientId: UserId, query: InboxQuery): Promise<Page<NotificationMessageRecord>> {
    return this.messages.listInbox(recipientId, query);
  }

  unreadCount(recipientId: UserId): Promise<number> {
    return this.messages.countUnread(recipientId);
  }

  markRead(id: NotificationMessageId): Promise<void> {
    return this.messages.markRead(id, this.clock.now());
  }

  markAllRead(recipientId: UserId): Promise<number> {
    return this.messages.markAllRead(recipientId, this.clock.now());
  }

  /**
   * The branding an email is wrapped in — 18 §6, from the settings catalogue.
   *
   * Read once per `notify` rather than per message: a batch of forty recipients is one fact
   * being announced, and forty identical settings reads for it would be forty round trips the
   * cache would serve and one of them would still pay for.
   */
  private async brandingFor(): Promise<Branding> {
    const logoUrl = await this.settings.get(Settings.NOTIFICATION_BRAND_LOGO_URL);
    return {
      name: await this.settings.get(Settings.NOTIFICATION_BRAND_NAME),
      color: await this.settings.get(Settings.NOTIFICATION_BRAND_COLOR),
      logoUrl: logoUrl.length > 0 ? logoUrl : null,
    };
  }

  /**
   * Whether this message waits, and for what.
   *
   * The two holds compose by taking the later instant. A digest collected at 03:00 would defeat
   * the quiet hours it was collected under, and quiet hours that released at 07:00 into a daily
   * digest window would send a message the digest is about to name.
   */
  private holdFor(
    definition: NotificationTypeDefinition,
    preference: RecipientPreference | null,
    quietHours: Parameters<typeof releaseAfterQuietHours>[0],
    timezone: string,
    digestHour: number,
  ): { releaseAt: Date | null; digestWindow: DigestFrequencyKey | null } {
    const now = this.clock.now();
    const quietUntil = releaseAfterQuietHours(quietHours, now);

    const frequency = preference?.digest ?? DigestFrequency.IMMEDIATE;
    const digestUntil = shouldSendImmediately(definition, preference)
      ? null
      : digestWindowEnd(frequency, now, timezone, digestHour);

    if (digestUntil === null) {
      return { releaseAt: quietUntil, digestWindow: null };
    }
    const releaseAt =
      quietUntil !== null && quietUntil.getTime() > digestUntil.getTime()
        ? quietUntil
        : digestUntil;
    return { releaseAt, digestWindow: frequency };
  }

  private async createMessage(input: {
    command: NotifyCommand;
    definition: NotificationTypeDefinition;
    contact: UserContact;
    channel: NotificationChannelKey;
    locale: string;
    branding: Branding;
    hold: { releaseAt: Date | null; digestWindow: DigestFrequencyKey | null };
  }): Promise<NotificationMessageId | null> {
    const { command, definition, contact, channel, locale, branding, hold } = input;
    // Deterministic per (event, recipient, channel), so re-running the producer of an event
    // cannot put the same notification in somebody's inbox twice (§7).
    const idempotencyKey = `${command.eventId}:${contact.userId}:${channel}`;

    const existing = await this.messages.findByIdempotencyKey(idempotencyKey);
    if (existing) {
      return null;
    }

    const template =
      (await this.templates.findOverride(command.typeKey, channel, locale)) ??
      defaultTemplate(command.typeKey, locale, channel);

    if (!template) {
      // A channel the type has no template for. Not an error — `document.checked-out` has an
      // in-app template and no email one, by 18 §4's own choice — but worth saying once.
      this.logger.debug('No template for this notification type and channel', {
        typeKey: command.typeKey,
        channel,
        locale,
      });
      return null;
    }

    const { message, failures } = renderMessage(
      template,
      { displayName: contact.displayName, ...command.values },
      ['displayName', ...definition.variables],
    );

    if (!message) {
      // A template that cannot render is a configuration fault. It is logged and skipped
      // rather than thrown, because one broken template must not stop the other recipients —
      // and never rendered with blanks, which would reach a person looking like a defect.
      this.logger.error('Notification template could not be rendered', {
        typeKey: command.typeKey,
        channel,
        locale,
        failures: failures.map((failure) => `${failure.reason}:${failure.variable}`).join(','),
      });
      return null;
    }

    // Checked before the row is written, so an address the tenant has stopped writing to
    // produces a `SUPPRESSED` record rather than a queued message that will be refused. The
    // record still exists: §8 forbids silently dropping a notification, and "we did not try,
    // because this address is dead" is exactly what somebody investigating needs to read.
    const suppressed =
      channel === NotificationChannel.EMAIL &&
      (await this.suppressions.isSuppressed(contact.email));

    const state = suppressed
      ? DeliveryState.SUPPRESSED
      : channel === NotificationChannel.IN_APP
        ? // In-app has no adapter: the row is the delivery, so it is delivered the moment it is
          // written. Everything else waits for a sender.
          DeliveryState.DELIVERED
        : hold.releaseAt !== null
          ? DeliveryState.HELD
          : DeliveryState.QUEUED;

    const id = asId<NotificationMessageId>(uuidv7(this.clock.now().getTime()));
    await this.messages.create({
      id,
      recipientId: contact.userId,
      typeKey: command.typeKey,
      channel,
      locale,
      subject: message.subject,
      bodyText: message.bodyText,
      // The envelope is applied here rather than at delivery, so the row records what was
      // actually sent — including the branding in force at the time. A tenant that rebrands
      // next month must not change what last month's record says it sent.
      bodyHtml:
        message.bodyHtml === null
          ? null
          : wrapEmailHtml(message.bodyHtml, {
              locale,
              branding,
              preheader: message.subject,
            }),
      state,
      idempotencyKey,
      address: contact.email,
      releaseAt: suppressed ? null : hold.releaseAt,
      digestWindow: suppressed ? null : hold.digestWindow,
      failureReason: suppressed ? 'The address is suppressed after repeated hard bounces.' : null,
    });
    return id;
  }
}
