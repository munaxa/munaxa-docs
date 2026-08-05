import { Inject, Injectable } from '@nestjs/common';

import {
  type AnyId,
  type NotificationChannelKey,
  type UserId,
  AVAILABLE_NOTIFICATION_CHANNELS,
  AuditSubjectType,
  DigestFrequency,
  Settings,
  asId,
} from '@edms/domain';
import type { Page, PageRequest } from '@edms/utils';

import {
  AdministeredWriter,
  AdministrativeOperation,
} from '../../../core/persistence/administered-writer';
import { SETTINGS_READER, type SettingsReader } from '../../../core/settings/settings.port';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { ValidationError } from '../../../core/errors/application-errors';
import { defaultTemplate } from '../domain/default-templates';
import {
  type NotificationTypeDefinition,
  ALL_NOTIFICATION_TYPES,
  notificationTypeFor,
} from '../domain/notification-types';
import { type QuietHoursWindow, localMinuteOfDay } from '../domain/quiet-hours';
import { NotificationAudit } from '../domain/audit-actions';
import { type MessageTemplate, render } from '../domain/template';
import {
  NOTIFICATION_PREFERENCE_REPOSITORY,
  NOTIFICATION_SUPPRESSION_REPOSITORY,
  NOTIFICATION_TEMPLATE_REPOSITORY,
  type NotificationPreferenceRepository,
  type NotificationSuppressionRepository,
  type NotificationTemplateRepository,
  type StoredPreference,
  type SuppressionRecord,
  type TemplateOverrideRecord,
} from './notification.ports';

/** The channels a type can actually be delivered on: available, and with a template. */
export interface TypeDescriptor {
  readonly definition: NotificationTypeDefinition;
  readonly availableChannels: readonly NotificationChannelKey[];
}

/**
 * The two configuration surfaces this module offers: a person's own preferences, and a tenant's
 * template overrides.
 *
 * They are one service because they share the catalogue and nothing else, and splitting them
 * would mean two classes each holding half of "what is a notification type" — but they are
 * emphatically **not** one screen. A preference is the caller's own and needs no permission; an
 * override is tenant configuration and lives behind `settings:manage` on an administration
 * screen. The controllers keep them apart; this keeps the catalogue in one place.
 */
@Injectable()
export class NotificationAdminService {
  constructor(
    @Inject(NOTIFICATION_PREFERENCE_REPOSITORY)
    private readonly preferences: NotificationPreferenceRepository,
    @Inject(NOTIFICATION_TEMPLATE_REPOSITORY)
    private readonly templates: NotificationTemplateRepository,
    @Inject(NOTIFICATION_SUPPRESSION_REPOSITORY)
    private readonly suppressions: NotificationSuppressionRepository,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly writer: AdministeredWriter,
  ) {}

  // --- The catalogue -------------------------------------------------------------------------

  /**
   * Every type a person may express an opinion about, with the channels it can reach them on.
   *
   * A channel with no template is not offered. Choosing email for `document.checked-out` would be
   * choosing a message that does not exist — 18 §4 gives that row "in-app" and no more — and a
   * preference screen that offered it would be promising something the renderer then declines to
   * produce.
   */
  async describeTypes(): Promise<readonly TypeDescriptor[]> {
    const locale = await this.settings.get(Settings.DEFAULT_LOCALE);
    return ALL_NOTIFICATION_TYPES.filter(
      // The digest envelope is a message the product sends *about* preferences; it is not a
      // preference. Offering "how would you like to receive your digest" is a question with one
      // answer already given by choosing a digest at all.
      (definition) => definition.key !== 'digest.summary',
    ).map((definition) => ({
      definition,
      availableChannels: AVAILABLE_NOTIFICATION_CHANNELS.filter(
        (channel) => defaultTemplate(definition.key, locale, channel) !== null,
      ),
    }));
  }

  // --- One person's own preferences ----------------------------------------------------------

  listPreferences(userId: UserId): Promise<readonly StoredPreference[]> {
    return this.writer.read(() => this.preferences.listFor(userId));
  }

  /**
   * Saves one person's choice for one type.
   *
   * **Not audited.** 13 §2 names no action for it and this phase added one row, not two: a
   * preference is somebody's own arrangement about their own mail, it grants nothing and
   * withdraws nothing from anybody else, and an audit row per checkbox would bury the
   * suppression event this phase *did* add in a table of them. What a preference cannot do —
   * silence a mandatory type — is enforced by `channelsFor` at send time rather than refused
   * here, so a tenant that later marks a type mandatory does not leave stored preferences that
   * would now be illegal.
   */
  async savePreference(
    userId: UserId,
    typeKey: string,
    input: { readonly channels: readonly NotificationChannelKey[]; readonly digest: string },
  ): Promise<void> {
    const definition = notificationTypeFor(typeKey);
    if (definition === null) {
      throw new ValidationError(`'${typeKey}' is not a notification type this product defines.`);
    }
    const digest = (Object.values(DigestFrequency) as readonly string[]).includes(input.digest)
      ? (input.digest as StoredPreference['digest'])
      : DigestFrequency.IMMEDIATE;

    await this.writer.read(() =>
      this.preferences.save(userId, typeKey, { channels: input.channels, digest }),
    );
  }

  clearPreference(userId: UserId, typeKey: string): Promise<void> {
    return this.writer.read(() => this.preferences.clear(userId, typeKey));
  }

  findQuietHours(userId: UserId): Promise<QuietHoursWindow | null> {
    return this.writer.read(() => this.preferences.findQuietHours(userId));
  }

  /**
   * Saves quiet hours, refusing a zone the runtime cannot resolve.
   *
   * Validated against `Intl` rather than against a list, because the IANA database is updated
   * several times a year and a hand-kept list would refuse zones that exist. A stored zone the
   * runtime cannot read would make every send for that person throw at delivery time.
   */
  async saveQuietHours(userId: UserId, window: QuietHoursWindow | null): Promise<void> {
    if (window !== null && localMinuteOfDay(new Date(), window.timezone) === null) {
      throw new ValidationError(`'${window.timezone}' is not a timezone this runtime knows.`);
    }
    await this.writer.read(() => this.preferences.saveQuietHours(userId, window));
  }

  // --- Tenant template overrides --------------------------------------------------------------

  listTemplates(): Promise<readonly TemplateOverrideRecord[]> {
    return this.writer.read(() => this.templates.listOverrides());
  }

  /** The shipped template for a `(type, channel, locale)`, so an editor starts from it. */
  shipped(
    typeKey: string,
    channel: NotificationChannelKey,
    locale: string,
  ): MessageTemplate | null {
    return defaultTemplate(typeKey, locale, channel);
  }

  /**
   * Saves a tenant's override — audited, because it changes what everybody in the tenant is told.
   *
   * Under `SETTING_CHANGED` rather than a Notification action of its own: 13 §2 "names one action
   * per area, not one per resource and verb", and a template is tenant configuration in exactly
   * the way a setting is. The payload names which template, and the before/after are deliberately
   * absent — a template body is up to twenty thousand characters, and copying two of them into an
   * audit payload would make the trail a second store of the thing it is describing (13 §3).
   *
   * The placeholders are checked here as well as at send time. An administrator who writes
   * `{{ password }}` learns about it while they are editing, rather than the product learning
   * about it when somebody is not told something.
   */
  async saveTemplate(
    typeKey: string,
    channel: NotificationChannelKey,
    locale: string,
    template: MessageTemplate,
  ): Promise<void> {
    const definition = notificationTypeFor(typeKey);
    if (definition === null) {
      throw new ValidationError(`'${typeKey}' is not a notification type this product defines.`);
    }
    const declared = ['displayName', ...definition.variables];
    const undeclared = [
      ...collectUndeclared(template.subject, declared),
      ...collectUndeclared(template.bodyText, declared),
      ...collectUndeclared(template.bodyHtml ?? '', declared),
    ];
    if (undeclared.length > 0) {
      throw new ValidationError(
        `This template uses placeholders '${[...new Set(undeclared)].join(', ')}', which '${typeKey}' does not provide.`,
      );
    }

    await this.writer.write(async () => {
      await this.templates.saveOverride(typeKey, channel, locale, template);
      return {
        result: undefined,
        change: {
          action: NotificationAudit.TEMPLATE_CHANGED,
          subjectType: AuditSubjectType.CONFIGURATION,
          // The tenant, as every settings change is filed — the subject column is a UUID, and
          // which template changed is in the payload where a filter can find it.
          subjectId: asId<AnyId>(requireContext().tenantId),
          operation: AdministrativeOperation.UPDATED,
          after: { notificationTemplate: typeKey, channel, locale },
        },
      };
    });
  }

  async deleteTemplate(
    typeKey: string,
    channel: NotificationChannelKey,
    locale: string,
  ): Promise<boolean> {
    return this.writer.write(async () => {
      const removed = await this.templates.deleteOverride(typeKey, channel, locale);
      return {
        result: removed,
        change: {
          action: NotificationAudit.TEMPLATE_CHANGED,
          subjectType: AuditSubjectType.CONFIGURATION,
          subjectId: asId<AnyId>(requireContext().tenantId),
          operation: AdministrativeOperation.DELETED,
          before: { notificationTemplate: typeKey, channel, locale },
        },
      };
    });
  }

  // --- Suppressed addresses --------------------------------------------------------------------

  listSuppressed(page: PageRequest): Promise<Page<SuppressionRecord>> {
    return this.writer.read(() => this.suppressions.list(page));
  }

  /**
   * Lifts a suppression — an administrator saying the address was corrected.
   *
   * Not audited, and that is the asymmetry it looks like. The suppression is the act that stops a
   * person being told things and is therefore in the trail; lifting one restores the ordinary
   * state, and the next bounce writes the next suppression with its own count. An audit row for
   * "we tried again" would answer no question the first row does not.
   */
  releaseSuppression(address: string): Promise<boolean> {
    return this.writer.read(() => this.suppressions.release(address));
  }
}

/** Placeholders a template uses that its type does not declare. */
function collectUndeclared(text: string, declared: readonly string[]): readonly string[] {
  const { failures } = render(text, {}, declared, { escape: false });
  return failures
    .filter((failure) => failure.reason === 'UNDECLARED_VARIABLE')
    .map((failure) => failure.variable);
}
