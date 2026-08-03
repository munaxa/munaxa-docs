import { type NotificationChannelKey, NotificationChannel } from '@edms/domain';

import type { MessageTemplate } from './template';
import { NotificationType } from './notification-types';

/**
 * The templates the product ships, per `(type, locale, channel)`.
 *
 * A tenant may override any of these — that is what the `notification_template` table is for —
 * but the defaults are complete, so a tenant that has customised nothing still receives correct,
 * translated notifications. The same argument as settings: a default is the product's opinion,
 * not a placeholder.
 *
 * These are the security types, and their wording follows one rule: say what happened, say when,
 * and say what to do if it was not you. A security notification that only says "an event
 * occurred" wastes the one chance to reach someone whose account is being taken over.
 *
 * No template here carries a secret, a token or document content
 * (`docs/architecture/18-notification-architecture.md` §6).
 */

type TemplateTable = Readonly<
  Record<string, Readonly<Record<string, Partial<Record<NotificationChannelKey, MessageTemplate>>>>>
>;

const EMAIL = NotificationChannel.EMAIL;
const IN_APP = NotificationChannel.IN_APP;

export const DEFAULT_TEMPLATES: TemplateTable = Object.freeze({
  [NotificationType.SECURITY_SIGN_IN_FROM_NEW_DEVICE.key]: {
    en: {
      [EMAIL]: {
        subject: 'New sign-in to your Munaxa Docs account',
        bodyText:
          'Hello {{displayName}},\n\n' +
          'Your account was signed in to from a device we have not seen before, at {{occurredAt}} from {{ipAddress}}.\n\n' +
          'If this was you, there is nothing to do.\n' +
          'If it was not, change your password now and tell your administrator.',
        bodyHtml:
          '<p>Hello {{displayName}},</p>' +
          '<p>Your account was signed in to from a device we have not seen before, at {{occurredAt}} from {{ipAddress}}.</p>' +
          '<p>If this was you, there is nothing to do.<br>If it was not, change your password now and tell your administrator.</p>',
      },
    },
    ar: {
      [EMAIL]: {
        subject: 'تسجيل دخول جديد إلى حسابك في مناخة للوثائق',
        bodyText:
          'مرحبًا {{displayName}}،\n\n' +
          'تم تسجيل الدخول إلى حسابك من جهاز لم نره من قبل، في {{occurredAt}} من {{ipAddress}}.\n\n' +
          'إن كنت أنت، فلا حاجة لأي إجراء.\n' +
          'وإن لم تكن أنت، غيّر كلمة المرور الآن وأبلغ المسؤول.',
        bodyHtml:
          '<p>مرحبًا {{displayName}}،</p>' +
          '<p>تم تسجيل الدخول إلى حسابك من جهاز لم نره من قبل، في {{occurredAt}} من {{ipAddress}}.</p>' +
          '<p>إن كنت أنت، فلا حاجة لأي إجراء.<br>وإن لم تكن أنت، غيّر كلمة المرور الآن وأبلغ المسؤول.</p>',
      },
    },
  },

  [NotificationType.SECURITY_PASSWORD_CHANGED.key]: {
    en: {
      [EMAIL]: {
        subject: 'Your Munaxa Docs password was changed',
        bodyText:
          'Hello {{displayName}},\n\n' +
          'Your password was changed at {{occurredAt}}.\n\n' +
          'If you did not change it, your account may be compromised. Tell your administrator immediately.',
        bodyHtml:
          '<p>Hello {{displayName}},</p>' +
          '<p>Your password was changed at {{occurredAt}}.</p>' +
          '<p>If you did not change it, your account may be compromised. Tell your administrator immediately.</p>',
      },
    },
    ar: {
      [EMAIL]: {
        subject: 'تم تغيير كلمة المرور الخاصة بك في مناخة للوثائق',
        bodyText:
          'مرحبًا {{displayName}}،\n\n' +
          'تم تغيير كلمة المرور في {{occurredAt}}.\n\n' +
          'إن لم تكن أنت من غيّرها، فقد يكون حسابك مخترقًا. أبلغ المسؤول فورًا.',
        bodyHtml:
          '<p>مرحبًا {{displayName}}،</p>' +
          '<p>تم تغيير كلمة المرور في {{occurredAt}}.</p>' +
          '<p>إن لم تكن أنت من غيّرها، فقد يكون حسابك مخترقًا. أبلغ المسؤول فورًا.</p>',
      },
    },
  },

  [NotificationType.SECURITY_SESSION_REVOKED.key]: {
    en: {
      [EMAIL]: {
        subject: 'A session on your Munaxa Docs account was ended',
        bodyText:
          'Hello {{displayName}},\n\n' +
          'A session on your account was ended at {{occurredAt}}. Reason: {{reason}}.\n\n' +
          'If you did not expect this, sign in again and tell your administrator.',
        bodyHtml:
          '<p>Hello {{displayName}},</p>' +
          '<p>A session on your account was ended at {{occurredAt}}. Reason: {{reason}}.</p>' +
          '<p>If you did not expect this, sign in again and tell your administrator.</p>',
      },
      [IN_APP]: {
        subject: 'A session was ended',
        bodyText: 'A session on your account was ended at {{occurredAt}} ({{reason}}).',
        bodyHtml: null,
      },
    },
    ar: {
      [EMAIL]: {
        subject: 'تم إنهاء جلسة على حسابك في مناخة للوثائق',
        bodyText:
          'مرحبًا {{displayName}}،\n\n' +
          'تم إنهاء جلسة على حسابك في {{occurredAt}}. السبب: {{reason}}.\n\n' +
          'إن لم تكن تتوقع ذلك، سجّل الدخول مرة أخرى وأبلغ المسؤول.',
        bodyHtml:
          '<p>مرحبًا {{displayName}}،</p>' +
          '<p>تم إنهاء جلسة على حسابك في {{occurredAt}}. السبب: {{reason}}.</p>' +
          '<p>إن لم تكن تتوقع ذلك، سجّل الدخول مرة أخرى وأبلغ المسؤول.</p>',
      },
      [IN_APP]: {
        subject: 'تم إنهاء جلسة',
        bodyText: 'تم إنهاء جلسة على حسابك في {{occurredAt}} ({{reason}}).',
        bodyHtml: null,
      },
    },
  },
});

/**
 * The shipped template for a type, locale and channel.
 *
 * Falls back to English rather than to nothing: an untranslated notification in a language the
 * recipient can probably read beats silence about their own account.
 */
export function defaultTemplate(
  typeKey: string,
  locale: string,
  channel: NotificationChannelKey,
): MessageTemplate | null {
  const byLocale = DEFAULT_TEMPLATES[typeKey];
  if (!byLocale) {
    return null;
  }
  return byLocale[locale]?.[channel] ?? byLocale['en']?.[channel] ?? null;
}
