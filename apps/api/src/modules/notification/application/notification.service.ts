import { Inject, Injectable } from '@nestjs/common';

import {
  type NotificationChannelKey,
  type NotificationMessageId,
  type UserId,
  AVAILABLE_NOTIFICATION_CHANNELS,
  DeliveryState,
  NotificationChannel,
  Settings,
  asId,
} from '@edms/domain';
import { type Page, type PageRequest, uuidv7 } from '@edms/utils';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import {
  USER_DIRECTORY,
  type UserContact,
  type UserDirectory,
} from '../../identity/application/ports';
import { defaultTemplate } from '../domain/default-templates';
import { channelsFor, notificationTypeFor } from '../domain/notification-types';
import { renderMessage } from '../domain/template';
import {
  NOTIFICATION_MESSAGE_REPOSITORY,
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  type NotificationMessageRecord,
  type NotificationMessageRepository,
  type NotificationPreferenceRepository,
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
 * Nothing is delivered here. This produces `QUEUED` rows; `DeliveryService` sends them. In-app
 * notifications are the exception by nature: the row *is* the delivery, which is why a mail
 * outage never affects them (§7).
 */
@Injectable()
export class DefaultNotificationService {
  constructor(
    @Inject(NOTIFICATION_MESSAGE_REPOSITORY)
    private readonly messages: NotificationMessageRepository,
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly preferences: NotificationPreferenceRepository,
    @Inject(NOTIFICATION_TEMPLATE_REPOSITORY)
    private readonly templates: NotificationTemplateRepository,
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

    const contacts = await this.users.contactsFor(command.recipientIds);
    if (contacts.length === 0) {
      return [];
    }

    const locale = await this.settings.get(Settings.DEFAULT_LOCALE);
    const created: NotificationMessageId[] = [];

    for (const contact of contacts) {
      const preference = await this.preferences.findFor(contact.userId, definition.key);
      const channels = channelsFor(definition, preference, AVAILABLE_NOTIFICATION_CHANNELS);

      for (const channel of channels) {
        const id = await this.createMessage(
          command,
          definition.variables,
          contact,
          channel,
          locale,
        );
        if (id) {
          created.push(id);
        }
      }
    }
    return created;
  }

  inbox(recipientId: UserId, page: PageRequest): Promise<Page<NotificationMessageRecord>> {
    return this.messages.listInbox(recipientId, page);
  }

  markRead(id: NotificationMessageId): Promise<void> {
    return this.messages.markRead(id, this.clock.now());
  }

  private async createMessage(
    command: NotifyCommand,
    variables: readonly string[],
    contact: UserContact,
    channel: NotificationChannelKey,
    locale: string,
  ): Promise<NotificationMessageId | null> {
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
      // A channel the type has no template for. Not an error — `security.session.revoked` has
      // an in-app template and `security.password.changed` does not — but worth saying once.
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
      ['displayName', ...variables],
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

    const id = asId<NotificationMessageId>(uuidv7(this.clock.now().getTime()));
    await this.messages.create({
      id,
      recipientId: contact.userId,
      typeKey: command.typeKey,
      channel,
      locale,
      subject: message.subject,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml,
      // In-app has no adapter: the row is the delivery, so it is delivered the moment it is
      // written. Everything else waits for a sender.
      state:
        channel === NotificationChannel.IN_APP ? DeliveryState.DELIVERED : DeliveryState.QUEUED,
      idempotencyKey,
      address: contact.email,
    });
    return id;
  }
}
