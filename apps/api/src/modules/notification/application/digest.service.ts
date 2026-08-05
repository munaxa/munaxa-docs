import { Inject, Injectable } from '@nestjs/common';

import {
  type DigestFrequencyKey,
  type NotificationMessageId,
  type UserId,
  DeliveryState,
  NotificationChannel,
  Settings,
  asId,
} from '@edms/domain';
import { uuidv7 } from '@edms/utils';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../core/prisma/unit-of-work';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { CLOCK_PORT, type ClockPort } from '../../../ports/clock.port';
import { USER_DIRECTORY, type UserDirectory } from '../../identity/application/ports';
import { defaultTemplate } from '../domain/default-templates';
import { composeDigestItems, periodLabelFor } from '../domain/digest';
import { type Branding, wrapEmailHtml } from '../domain/email-layout';
import { NotificationType } from '../domain/notification-types';
import { renderMessage } from '../domain/template';
import {
  NOTIFICATION_MESSAGE_REPOSITORY,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  type NotificationMessageRecord,
  type NotificationMessageRepository,
  type NotificationTemplateRepository,
} from './notification.ports';

/** How many held messages one collection pass gathers. A digest of more than this is a defect. */
const COLLECT_LIMIT = 2_000;

/**
 * Collecting a closed digest window into one message per recipient.
 *
 * The accumulator is the `HELD` rows themselves: nothing is kept in memory, nothing is keyed on
 * an "open digest" record, and a process that dies mid-window loses nothing because the window
 * lives on the messages. A pass claims everything whose `release_at` has passed for one
 * frequency, groups it by recipient, and writes one `digest.summary` message per group.
 *
 * ## The members are not deleted, and not sent
 *
 * They move to `DIGESTED` and gain a foreign key to the summary that carried them. That keeps two
 * facts a delete would destroy: that the notification existed at all — 18 §8 forbids one being
 * silently dropped — and which summary a person would have read it in, which is the only way to
 * answer "was I told about this?" when they say they were not.
 *
 * ## The list is composed here, not by the renderer
 *
 * `template.ts` substitutes and does nothing else, deliberately. So the items are assembled into
 * one plain-text value by `composeDigestItems` and handed to the renderer like any other value —
 * escaped for the HTML body exactly as a document title is. The template language gains no loop
 * and the digest gains a list, which is what keeping composition and substitution apart is for.
 */
@Injectable()
export class DigestService {
  constructor(
    @Inject(NOTIFICATION_MESSAGE_REPOSITORY)
    private readonly messages: NotificationMessageRepository,
    @Inject(NOTIFICATION_TEMPLATE_REPOSITORY)
    private readonly templates: NotificationTemplateRepository,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    @Inject(CLOCK_PORT) private readonly clock: ClockPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Collects one frequency's closed windows. Returns how many summaries it produced.
   *
   * One transaction for the whole pass rather than one per recipient, because the claim and the
   * `DIGESTED` transition have to be atomic together: a crash between them would leave messages
   * a summary already names still waiting to be sent individually.
   */
  async collect(frequency: DigestFrequencyKey): Promise<number> {
    const now = this.clock.now();
    const locale = await this.settings.get(Settings.DEFAULT_LOCALE);
    const branding = await this.brandingFor();

    return this.unitOfWork.run(async () => {
      const held = await this.messages.claimForDigest(frequency, now, COLLECT_LIMIT);
      if (held.length === 0) {
        return 0;
      }

      const byRecipient = new Map<UserId, NotificationMessageRecord[]>();
      for (const message of held) {
        // Email only. In-app is never held — §3 calls it the authoritative inbox, and a digest
        // exists to replace a stream of *emails* — so a held in-app row would be a defect
        // upstream rather than something to roll up here.
        if (message.channel !== NotificationChannel.EMAIL) {
          continue;
        }
        const existing = byRecipient.get(message.recipientId);
        if (existing) {
          existing.push(message);
        } else {
          byRecipient.set(message.recipientId, [message]);
        }
      }

      const contacts = await this.users.contactsFor([...byRecipient.keys()]);
      let produced = 0;

      for (const contact of contacts) {
        const members = byRecipient.get(contact.userId) ?? [];
        if (members.length === 0) {
          continue;
        }
        const summaryId = await this.writeSummary(
          contact.userId,
          contact.displayName,
          contact.email,
          members,
          frequency,
          locale,
          branding,
          now,
        );
        if (summaryId === null) {
          continue;
        }
        await this.messages.markDigested(
          members.map((member) => member.id),
          summaryId,
        );
        produced += 1;
      }
      return produced;
    });
  }

  private async writeSummary(
    recipientId: UserId,
    displayName: string,
    address: string,
    members: readonly NotificationMessageRecord[],
    frequency: DigestFrequencyKey,
    locale: string,
    branding: Branding,
    now: Date,
  ): Promise<NotificationMessageId | null> {
    const definition = NotificationType.DIGEST_SUMMARY;
    const template =
      (await this.templates.findOverride(definition.key, NotificationChannel.EMAIL, locale)) ??
      defaultTemplate(definition.key, locale, NotificationChannel.EMAIL);

    if (template === null) {
      this.logger.error('The digest template is missing', { locale });
      return null;
    }

    const { message, failures } = renderMessage(
      template,
      {
        displayName,
        itemCount: String(members.length),
        items: composeDigestItems(
          members.map((member) => ({ subject: member.subject, occurredAt: member.createdAt })),
        ),
        periodLabel: periodLabelFor(frequency, locale),
      },
      ['displayName', ...definition.variables],
    );

    if (message === null) {
      this.logger.error('The digest could not be rendered', {
        locale,
        failures: failures.map((failure) => `${failure.reason}:${failure.variable}`).join(','),
      });
      return null;
    }

    const id = asId<NotificationMessageId>(uuidv7(now.getTime()));
    await this.messages.create({
      id,
      recipientId,
      typeKey: definition.key,
      channel: NotificationChannel.EMAIL,
      locale,
      subject: message.subject,
      bodyText: message.bodyText,
      bodyHtml:
        message.bodyHtml === null
          ? null
          : wrapEmailHtml(message.bodyHtml, { locale, branding, preheader: message.subject }),
      state: DeliveryState.QUEUED,
      // Keyed on the recipient and the window that closed. It is not what makes the pass
      // idempotent — the claim and the `DIGESTED` transition share one transaction, so a
      // redelivery finds nothing still `HELD` — but it is what makes a second pass *fail loudly*
      // on the unique index rather than quietly sending a second copy, if that ever stops being
      // true.
      idempotencyKey: `digest:${frequency}:${recipientId}:${String(windowKey(members))}`,
      address,
      releaseAt: null,
      digestWindow: null,
      failureReason: null,
    });
    return id;
  }

  private async brandingFor(): Promise<Branding> {
    const logoUrl = await this.settings.get(Settings.NOTIFICATION_BRAND_LOGO_URL);
    return {
      name: await this.settings.get(Settings.NOTIFICATION_BRAND_NAME),
      color: await this.settings.get(Settings.NOTIFICATION_BRAND_COLOR),
      logoUrl: logoUrl.length > 0 ? logoUrl : null,
    };
  }
}

/**
 * The window a set of collected messages belongs to, as a number.
 *
 * The latest `release_at` among them, which is the same instant for every message a window
 * closed over. It is what makes the summary's idempotency key deterministic without a window
 * table: two passes over the same closed window produce the same key, and the second writes
 * nothing.
 */
function windowKey(members: readonly NotificationMessageRecord[]): number {
  return members.reduce((latest, member) => Math.max(latest, member.releaseAt?.getTime() ?? 0), 0);
}
