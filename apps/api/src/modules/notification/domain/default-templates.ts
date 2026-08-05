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
 * Their wording follows one rule, inherited from the security types Phase 1 wrote: say what
 * happened, say what it concerns, and say what the reader can do about it. A notification that
 * only says "an event occurred" wastes the one chance it has to reach somebody.
 *
 * No template here carries a secret, a token or document content
 * (`docs/architecture/18-notification-architecture.md` §6). A document's *title* is not its
 * content, and it is the only way a person can tell one notification from another — but which
 * people receive it at all is decided by the ACL before this file is ever reached.
 *
 * ## Why the bodies are built rather than written twice
 *
 * Phase 1 wrote the plain-text and the HTML body of each template as two literals. That was
 * right for three types and wrong for twenty-two: the two literals say the same sentences, and
 * the only way for them to differ is by mistake — a correction applied to one and not the other,
 * in a language the person applying it may not read.
 *
 * `body` therefore takes the paragraphs once and produces both. It is **not** a template engine
 * and does not become one: it runs at module load, over literals in this file, and never over a
 * tenant's stored override. `{{ placeholder }}` text passes through it untouched, to be
 * substituted later by the renderer that is deliberately not an engine, for the reason
 * `template.ts` states. A tenant override is stored as three fields and rendered exactly as it
 * is written.
 */

type TemplateTable = Readonly<
  Record<string, Readonly<Record<string, Partial<Record<NotificationChannelKey, MessageTemplate>>>>>
>;

const EMAIL = NotificationChannel.EMAIL;
const IN_APP = NotificationChannel.IN_APP;

/**
 * One message, as paragraphs.
 *
 * A single newline inside a paragraph is a line break in both renderings; a paragraph boundary
 * is a blank line in text and a `<p>` in HTML. That is the whole of the mapping, and it is why
 * this is a formatter rather than a language.
 */
function body(subject: string, paragraphs: readonly string[]): MessageTemplate {
  return {
    subject,
    bodyText: paragraphs.join('\n\n'),
    bodyHtml: paragraphs
      .map((paragraph) => `<p>${paragraph.replaceAll('\n', '<br>')}</p>`)
      .join(''),
  };
}

/** An in-app message: one line, no HTML, because the inbox renders it as text. */
function inApp(subject: string, text: string): MessageTemplate {
  return { subject, bodyText: text, bodyHtml: null };
}

export const DEFAULT_TEMPLATES: TemplateTable = Object.freeze({
  // --- Security (Phase 1) --------------------------------------------------------------------

  [NotificationType.SECURITY_SIGN_IN_FROM_NEW_DEVICE.key]: {
    en: {
      [EMAIL]: body('New sign-in to your Munaxa Docs account', [
        'Hello {{displayName}},',
        'Your account was signed in to from a device we have not seen before, at {{occurredAt}} from {{ipAddress}}.',
        'If this was you, there is nothing to do.\nIf it was not, change your password now and tell your administrator.',
      ]),
    },
    ar: {
      [EMAIL]: body('تسجيل دخول جديد إلى حسابك في مناخة للوثائق', [
        'مرحبًا {{displayName}}،',
        'تم تسجيل الدخول إلى حسابك من جهاز لم نره من قبل، في {{occurredAt}} من {{ipAddress}}.',
        'إن كنت أنت، فلا حاجة لأي إجراء.\nوإن لم تكن أنت، غيّر كلمة المرور الآن وأبلغ المسؤول.',
      ]),
    },
  },

  [NotificationType.SECURITY_PASSWORD_CHANGED.key]: {
    en: {
      [EMAIL]: body('Your Munaxa Docs password was changed', [
        'Hello {{displayName}},',
        'Your password was changed at {{occurredAt}}.',
        'If you did not change it, your account may be compromised. Tell your administrator immediately.',
      ]),
    },
    ar: {
      [EMAIL]: body('تم تغيير كلمة المرور الخاصة بك في مناخة للوثائق', [
        'مرحبًا {{displayName}}،',
        'تم تغيير كلمة المرور في {{occurredAt}}.',
        'إن لم تكن أنت من غيّرها، فقد يكون حسابك مخترقًا. أبلغ المسؤول فورًا.',
      ]),
    },
  },

  [NotificationType.SECURITY_SESSION_REVOKED.key]: {
    en: {
      [EMAIL]: body('A session on your Munaxa Docs account was ended', [
        'Hello {{displayName}},',
        'A session on your account was ended at {{occurredAt}}. Reason: {{reason}}.',
        'If you did not expect this, sign in again and tell your administrator.',
      ]),
      [IN_APP]: inApp(
        'A session was ended',
        'A session on your account was ended at {{occurredAt}} ({{reason}}).',
      ),
    },
    ar: {
      [EMAIL]: body('تم إنهاء جلسة على حسابك في مناخة للوثائق', [
        'مرحبًا {{displayName}}،',
        'تم إنهاء جلسة على حسابك في {{occurredAt}}. السبب: {{reason}}.',
        'إن لم تكن تتوقع ذلك، سجّل الدخول مرة أخرى وأبلغ المسؤول.',
      ]),
      [IN_APP]: inApp('تم إنهاء جلسة', 'تم إنهاء جلسة على حسابك في {{occurredAt}} ({{reason}}).'),
    },
  },

  // --- Workflow ------------------------------------------------------------------------------

  [NotificationType.APPROVAL_TASK_ASSIGNED.key]: {
    en: {
      [EMAIL]: body('Your approval is needed: {{documentTitle}}', [
        'Hello {{displayName}},',
        'You have an approval to decide at the “{{stageName}}” stage of {{documentNumber}} — {{documentTitle}}.',
        'It is due by {{dueAt}}.',
        'Open it to approve, reject or return it for modification: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'Approval needed: {{documentTitle}}',
        'You have an approval to decide at “{{stageName}}” on {{documentNumber}}, due {{dueAt}}.',
      ),
    },
    ar: {
      [EMAIL]: body('مطلوب اعتمادك: {{documentTitle}}', [
        'مرحبًا {{displayName}}،',
        'لديك اعتماد للبتّ فيه في مرحلة «{{stageName}}» من {{documentNumber}} — {{documentTitle}}.',
        'الموعد النهائي {{dueAt}}.',
        'افتح الوثيقة لاعتمادها أو رفضها أو إعادتها للتعديل: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'مطلوب اعتماد: {{documentTitle}}',
        'لديك اعتماد للبتّ فيه في «{{stageName}}» على {{documentNumber}}، موعده {{dueAt}}.',
      ),
    },
  },

  [NotificationType.APPROVAL_DEADLINE_APPROACHING.key]: {
    en: {
      [EMAIL]: body('Reminder: {{documentTitle}} is waiting for you', [
        'Hello {{displayName}},',
        'The approval at the “{{stageName}}” stage of {{documentNumber}} — {{documentTitle}} is still waiting for your decision.',
        'It is due by {{dueAt}}.',
        'Decide it here: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'Reminder: {{documentTitle}}',
        '“{{stageName}}” on {{documentNumber}} is still waiting for your decision, due {{dueAt}}.',
      ),
    },
    ar: {
      [EMAIL]: body('تذكير: {{documentTitle}} بانتظارك', [
        'مرحبًا {{displayName}}،',
        'ما زال الاعتماد في مرحلة «{{stageName}}» من {{documentNumber}} — {{documentTitle}} بانتظار قرارك.',
        'الموعد النهائي {{dueAt}}.',
        'يمكنك البتّ فيه هنا: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'تذكير: {{documentTitle}}',
        'ما زالت «{{stageName}}» على {{documentNumber}} بانتظار قرارك، وموعدها {{dueAt}}.',
      ),
    },
  },

  [NotificationType.APPROVAL_OVERDUE.key]: {
    en: {
      [EMAIL]: body('Overdue: {{documentTitle}}', [
        'Hello {{displayName}},',
        'The approval at the “{{stageName}}” stage of {{documentNumber}} — {{documentTitle}} passed its deadline of {{dueAt}} and has not been decided.',
        'Decide it here: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'Overdue: {{documentTitle}}',
        '“{{stageName}}” on {{documentNumber}} passed its deadline of {{dueAt}}.',
      ),
    },
    ar: {
      [EMAIL]: body('متأخر: {{documentTitle}}', [
        'مرحبًا {{displayName}}،',
        'تجاوز الاعتماد في مرحلة «{{stageName}}» من {{documentNumber}} — {{documentTitle}} موعده {{dueAt}} ولم يُبتّ فيه بعد.',
        'يمكنك البتّ فيه هنا: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'متأخر: {{documentTitle}}',
        'تجاوزت «{{stageName}}» على {{documentNumber}} موعدها {{dueAt}}.',
      ),
    },
  },

  // --- Document ------------------------------------------------------------------------------

  [NotificationType.DOCUMENT_APPROVED.key]: {
    en: {
      [EMAIL]: body('Approved: {{documentTitle}}', [
        'Hello {{displayName}},',
        '{{documentNumber}} — {{documentTitle}} completed its approval and has been given its number.',
        'Open it here: {{documentLink}}',
      ]),
      [IN_APP]: inApp('Approved: {{documentTitle}}', '{{documentNumber}} completed its approval.'),
    },
    ar: {
      [EMAIL]: body('تم الاعتماد: {{documentTitle}}', [
        'مرحبًا {{displayName}}،',
        'أكملت {{documentNumber}} — {{documentTitle}} دورة اعتمادها وحصلت على رقمها.',
        'يمكنك فتحها هنا: {{documentLink}}',
      ]),
      [IN_APP]: inApp('تم الاعتماد: {{documentTitle}}', 'أكملت {{documentNumber}} دورة اعتمادها.'),
    },
  },

  [NotificationType.DOCUMENT_REJECTED.key]: {
    en: {
      [EMAIL]: body('Rejected: {{documentTitle}}', [
        'Hello {{displayName}},',
        '{{documentNumber}} — {{documentTitle}} was rejected.',
        'The reason given was: {{comment}}',
        'Open it here: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'Rejected: {{documentTitle}}',
        '{{documentNumber}} was rejected. Reason: {{comment}}',
      ),
    },
    ar: {
      [EMAIL]: body('تم الرفض: {{documentTitle}}', [
        'مرحبًا {{displayName}}،',
        'تم رفض {{documentNumber}} — {{documentTitle}}.',
        'السبب المذكور: {{comment}}',
        'يمكنك فتحها هنا: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'تم الرفض: {{documentTitle}}',
        'تم رفض {{documentNumber}}. السبب: {{comment}}',
      ),
    },
  },

  [NotificationType.DOCUMENT_PUBLISHED.key]: {
    en: {
      [EMAIL]: body('Published: {{documentTitle}}', [
        'Hello {{displayName}},',
        '{{documentNumber}} — {{documentTitle}} has been published and is now the effective version.',
        'Read the current version here: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'Published: {{documentTitle}}',
        '{{documentNumber}} is now the effective version.',
      ),
    },
    ar: {
      [EMAIL]: body('تم النشر: {{documentTitle}}', [
        'مرحبًا {{displayName}}،',
        'تم نشر {{documentNumber}} — {{documentTitle}} وأصبحت النسخة السارية.',
        'اقرأ النسخة الحالية هنا: {{documentLink}}',
      ]),
      [IN_APP]: inApp('تم النشر: {{documentTitle}}', 'أصبحت {{documentNumber}} النسخة السارية.'),
    },
  },

  [NotificationType.DOCUMENT_CHECKED_OUT.key]: {
    en: {
      [IN_APP]: inApp(
        'Checked out: {{documentTitle}}',
        '{{documentNumber}} was checked out and is locked until {{expiresAt}}.',
      ),
    },
    ar: {
      [IN_APP]: inApp(
        'تم السحب: {{documentTitle}}',
        'تم سحب {{documentNumber}} وهي مقفلة حتى {{expiresAt}}.',
      ),
    },
  },

  [NotificationType.DOCUMENT_CHECKED_IN.key]: {
    en: {
      [IN_APP]: inApp(
        'Checked in: {{documentTitle}}',
        '{{documentNumber}} was checked in as revision {{revisionLabel}}.',
      ),
    },
    ar: {
      [IN_APP]: inApp(
        'تم الإرجاع: {{documentTitle}}',
        'تم إرجاع {{documentNumber}} كمراجعة {{revisionLabel}}.',
      ),
    },
  },

  // --- Delegation ----------------------------------------------------------------------------

  [NotificationType.DELEGATION_REQUESTED.key]: {
    en: {
      [EMAIL]: body('{{delegatorName}} has asked to delegate approvals', [
        'Hello {{displayName}},',
        '{{delegatorName}} has asked to delegate their approvals to {{delegateName}} from {{startsAt}} until {{endsAt}}.',
        'It does not take effect until somebody agrees to it: {{delegationLink}}',
      ]),
      [IN_APP]: inApp(
        'Delegation awaiting your agreement',
        '{{delegatorName}} asked to delegate approvals to {{delegateName}} from {{startsAt}} until {{endsAt}}.',
      ),
    },
    ar: {
      [EMAIL]: body('طلب {{delegatorName}} تفويض الاعتمادات', [
        'مرحبًا {{displayName}}،',
        'طلب {{delegatorName}} تفويض اعتماداته إلى {{delegateName}} من {{startsAt}} حتى {{endsAt}}.',
        'لا يسري التفويض حتى يوافق عليه أحد: {{delegationLink}}',
      ]),
      [IN_APP]: inApp(
        'تفويض بانتظار موافقتك',
        'طلب {{delegatorName}} تفويض الاعتمادات إلى {{delegateName}} من {{startsAt}} حتى {{endsAt}}.',
      ),
    },
  },

  [NotificationType.DELEGATION_APPROVED.key]: {
    en: {
      [EMAIL]: body('Delegation in force: {{delegatorName}} → {{delegateName}}', [
        'Hello {{displayName}},',
        '{{delegateName}} may now decide {{delegatorName}}’s approvals, from {{startsAt}} until {{endsAt}}.',
        'The tasks stay {{delegatorName}}’s; the delegation only decides who may act on them.',
        'See it here: {{delegationLink}}',
      ]),
      [IN_APP]: inApp(
        'Delegation in force',
        '{{delegateName}} may decide {{delegatorName}}’s approvals from {{startsAt}} until {{endsAt}}.',
      ),
    },
    ar: {
      [EMAIL]: body('تفويض ساري: {{delegatorName}} ← {{delegateName}}', [
        'مرحبًا {{displayName}}،',
        'يستطيع {{delegateName}} الآن البتّ في اعتمادات {{delegatorName}}، من {{startsAt}} حتى {{endsAt}}.',
        'تبقى المهام باسم {{delegatorName}}؛ التفويض يحدد من يجوز له التصرف فيها فقط.',
        'يمكنك الاطلاع عليه هنا: {{delegationLink}}',
      ]),
      [IN_APP]: inApp(
        'تفويض ساري',
        'يستطيع {{delegateName}} البتّ في اعتمادات {{delegatorName}} من {{startsAt}} حتى {{endsAt}}.',
      ),
    },
  },

  [NotificationType.DELEGATION_REVOKED.key]: {
    en: {
      [EMAIL]: body('Delegation ended: {{delegatorName}} → {{delegateName}}', [
        'Hello {{displayName}},',
        'The delegation from {{delegatorName}} to {{delegateName}} has been revoked.',
        'The reason given was: {{reason}}',
        'Every approval it covered is {{delegatorName}}’s again, immediately: {{delegationLink}}',
      ]),
      [IN_APP]: inApp(
        'Delegation revoked',
        'The delegation from {{delegatorName}} to {{delegateName}} was revoked. Reason: {{reason}}',
      ),
    },
    ar: {
      [EMAIL]: body('انتهى التفويض: {{delegatorName}} ← {{delegateName}}', [
        'مرحبًا {{displayName}}،',
        'تم إلغاء التفويض من {{delegatorName}} إلى {{delegateName}}.',
        'السبب المذكور: {{reason}}',
        'عادت كل الاعتمادات التي كان يغطيها إلى {{delegatorName}} فورًا: {{delegationLink}}',
      ]),
      [IN_APP]: inApp(
        'تم إلغاء التفويض',
        'تم إلغاء التفويض من {{delegatorName}} إلى {{delegateName}}. السبب: {{reason}}',
      ),
    },
  },

  [NotificationType.DELEGATION_EXPIRED.key]: {
    en: {
      [EMAIL]: body('Delegation expired: {{delegatorName}} → {{delegateName}}', [
        'Hello {{displayName}},',
        'The delegation from {{delegatorName}} to {{delegateName}} reached its end date of {{endsAt}} and is no longer in force.',
        'It was used for {{useCount}} decision(s).',
        'See it here: {{delegationLink}}',
      ]),
      [IN_APP]: inApp(
        'Delegation expired',
        'The delegation from {{delegatorName}} to {{delegateName}} ended on {{endsAt}} after {{useCount}} decision(s).',
      ),
    },
    ar: {
      [EMAIL]: body('انتهت صلاحية التفويض: {{delegatorName}} ← {{delegateName}}', [
        'مرحبًا {{displayName}}،',
        'بلغ التفويض من {{delegatorName}} إلى {{delegateName}} تاريخ انتهائه {{endsAt}} ولم يعد ساريًا.',
        'استُخدم في {{useCount}} من القرارات.',
        'يمكنك الاطلاع عليه هنا: {{delegationLink}}',
      ]),
      [IN_APP]: inApp(
        'انتهت صلاحية التفويض',
        'انتهى التفويض من {{delegatorName}} إلى {{delegateName}} في {{endsAt}} بعد {{useCount}} من القرارات.',
      ),
    },
  },

  // --- Retention -----------------------------------------------------------------------------

  [NotificationType.RETENTION_REVIEW_DUE.key]: {
    en: {
      [EMAIL]: body('{{documentCount}} document(s) are due for retention review', [
        'Hello {{displayName}},',
        '{{documentCount}} document(s) have reached their retention date and need a disposition decision.',
        'Review them here: {{reviewLink}}',
      ]),
      [IN_APP]: inApp(
        'Retention review due',
        '{{documentCount}} document(s) have reached their retention date.',
      ),
    },
    ar: {
      [EMAIL]: body('{{documentCount}} من الوثائق مستحقة لمراجعة الاحتفاظ', [
        'مرحبًا {{displayName}}،',
        'بلغت {{documentCount}} من الوثائق تاريخ الاحتفاظ وتحتاج قرار تصرّف.',
        'راجعها هنا: {{reviewLink}}',
      ]),
      [IN_APP]: inApp('مراجعة احتفاظ مستحقة', 'بلغت {{documentCount}} من الوثائق تاريخ الاحتفاظ.'),
    },
  },

  [NotificationType.LEGAL_HOLD_PLACED.key]: {
    en: {
      [EMAIL]: body('Legal hold placed: {{documentTitle}}', [
        'Hello {{displayName}},',
        'A legal hold was placed on {{documentNumber}} — {{documentTitle}}. It will not be disposed of, whatever its retention policy says.',
        'The stated ground was: {{reason}}',
        'Open it here: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'Legal hold placed: {{documentTitle}}',
        'A legal hold was placed on {{documentNumber}}. Reason: {{reason}}',
      ),
    },
    ar: {
      [EMAIL]: body('تم فرض حجز قانوني: {{documentTitle}}', [
        'مرحبًا {{displayName}}،',
        'فُرض حجز قانوني على {{documentNumber}} — {{documentTitle}}. لن يجري التصرّف بها مهما كانت سياسة الاحتفاظ.',
        'السبب المذكور: {{reason}}',
        'يمكنك فتحها هنا: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'تم فرض حجز قانوني: {{documentTitle}}',
        'فُرض حجز قانوني على {{documentNumber}}. السبب: {{reason}}',
      ),
    },
  },

  [NotificationType.LEGAL_HOLD_RELEASED.key]: {
    en: {
      [EMAIL]: body('Legal hold released: {{documentTitle}}', [
        'Hello {{displayName}},',
        'The legal hold on {{documentNumber}} — {{documentTitle}} was released. Its retention schedule resumes.',
        'Open it here: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'Legal hold released: {{documentTitle}}',
        'The legal hold on {{documentNumber}} was released.',
      ),
    },
    ar: {
      [EMAIL]: body('تم رفع الحجز القانوني: {{documentTitle}}', [
        'مرحبًا {{displayName}}،',
        'رُفع الحجز القانوني عن {{documentNumber}} — {{documentTitle}}، ويُستأنف جدول الاحتفاظ.',
        'يمكنك فتحها هنا: {{documentLink}}',
      ]),
      [IN_APP]: inApp(
        'تم رفع الحجز القانوني: {{documentTitle}}',
        'رُفع الحجز القانوني عن {{documentNumber}}.',
      ),
    },
  },

  // --- Security and operations ---------------------------------------------------------------

  [NotificationType.SECURITY_FILE_QUARANTINED.key]: {
    en: {
      [EMAIL]: body('A file you uploaded was quarantined', [
        'Hello {{displayName}},',
        '“{{filename}}” was quarantined at {{occurredAt}}. The scanner reported: {{verdict}}.',
        'The file was not stored and no document was created from it. If you believe this is wrong, tell your administrator.',
      ]),
      [IN_APP]: inApp(
        'A file was quarantined',
        '“{{filename}}” was quarantined at {{occurredAt}} ({{verdict}}).',
      ),
    },
    ar: {
      [EMAIL]: body('تم عزل ملف رفعته', [
        'مرحبًا {{displayName}}،',
        'تم عزل «{{filename}}» في {{occurredAt}}. أفاد الفاحص بـ: {{verdict}}.',
        'لم يُخزَّن الملف ولم تُنشأ منه أي وثيقة. إن كنت ترى أن هذا خطأ، أبلغ المسؤول.',
      ]),
      [IN_APP]: inApp('تم عزل ملف', 'تم عزل «{{filename}}» في {{occurredAt}} ({{verdict}}).'),
    },
  },

  [NotificationType.SECURITY_ADDRESS_SUPPRESSED.key]: {
    en: {
      [EMAIL]: body('An email address stopped accepting Munaxa Docs mail', [
        'Hello {{displayName}},',
        'Mail to {{maskedAddress}} was refused permanently {{bounceCount}} time(s), most recently at {{occurredAt}}, so it has been suppressed.',
        'Nothing further will be emailed to it until somebody corrects the address. In-app notifications are unaffected.',
      ]),
      [IN_APP]: inApp(
        'An email address was suppressed',
        'Mail to {{maskedAddress}} was refused {{bounceCount}} time(s) and has been suppressed.',
      ),
    },
    ar: {
      [EMAIL]: body('توقّف عنوان بريد عن قبول رسائل مناخة للوثائق', [
        'مرحبًا {{displayName}}،',
        'رُفض البريد إلى {{maskedAddress}} رفضًا نهائيًا {{bounceCount}} مرة، آخرها في {{occurredAt}}، فتم تعليقه.',
        'لن يُرسَل إليه أي بريد آخر حتى يُصحَّح العنوان. ولا تتأثر الإشعارات داخل التطبيق.',
      ]),
      [IN_APP]: inApp(
        'تم تعليق عنوان بريد',
        'رُفض البريد إلى {{maskedAddress}} {{bounceCount}} مرة وتم تعليقه.',
      ),
    },
  },

  [NotificationType.AUDIT_CHAIN_BROKEN.key]: {
    en: {
      [EMAIL]: body('Urgent: the audit chain failed verification', [
        'Hello {{displayName}},',
        'The daily verification of the audit trail failed at {{occurredAt}}. The accusation is: {{reason}}.',
        'This means a record was altered, inserted or removed. Treat it as an incident: preserve the database, and do not run anything that writes to the trail until it has been examined.',
        'The verification result is here: {{auditLink}}',
      ]),
    },
    ar: {
      [EMAIL]: body('عاجل: فشل التحقق من سلسلة التدقيق', [
        'مرحبًا {{displayName}}،',
        'فشل التحقق اليومي من سجل التدقيق في {{occurredAt}}. والاتهام هو: {{reason}}.',
        'يعني ذلك أن سجلًا قد عُدِّل أو أُدرج أو حُذف. تعامل مع الأمر كحادثة: احفظ قاعدة البيانات، ولا تشغّل ما يكتب في السجل حتى يُفحص.',
        'نتيجة التحقق هنا: {{auditLink}}',
      ]),
    },
  },

  // --- The digest envelope --------------------------------------------------------------------

  [NotificationType.DIGEST_SUMMARY.key]: {
    en: {
      [EMAIL]: body('Munaxa Docs: {{itemCount}} update(s) {{periodLabel}}', [
        'Hello {{displayName}},',
        'Here is what happened {{periodLabel}}.',
        '{{items}}',
        'You are receiving one message instead of {{itemCount}} because you chose a digest. Change it in your notification preferences.',
      ]),
    },
    ar: {
      [EMAIL]: body('مناخة للوثائق: {{itemCount}} من التحديثات {{periodLabel}}', [
        'مرحبًا {{displayName}}،',
        'إليك ما حدث {{periodLabel}}.',
        '{{items}}',
        'تتلقى رسالة واحدة بدل {{itemCount}} لأنك اخترت الملخّص. يمكنك تغيير ذلك من تفضيلات الإشعارات.',
      ]),
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
