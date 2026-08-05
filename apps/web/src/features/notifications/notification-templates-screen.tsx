'use client';

import { type ReactNode, useState } from 'react';

import { Badge, Button, Card, useToast } from '@munaxa/ui';

import type {
  NotificationTemplateOverride,
  NotificationTypeDescriptor,
  SuppressedAddress,
} from '@edms/contracts';

import { useRouter } from 'next/navigation';

import { useTranslate } from '../../app/providers';
import {
  AdminScreen,
  FormDialog,
  TextAreaField,
  TextField,
  optionalText,
  text,
} from '../admin-shared';
import {
  loadShippedTemplate,
  releaseSuppressedAddress,
  resetNotificationTemplate,
  saveNotificationTemplate,
} from './actions';
import { labelKeyFor } from './type-labels';

const LOCALES = ['en', 'ar'] as const;

/**
 * Configurable templates — the brief's last line, and 18 §6.
 *
 * On an administration screen rather than in the notification centre, because a template edit
 * reaches **everybody in the tenant**: it changes the words the product uses to tell forty people
 * their approval is needed. The notification centre next door is somebody's own inbox and their
 * own preferences, and the only thing separating the two would otherwise be a permission check —
 * which is a check somebody can forget to add.
 *
 * The editor starts from the template the product ships, fetched on demand. That is what makes an
 * override a *change* rather than a rewrite: an administrator adjusting one sentence should not
 * have to reconstruct the other four, and a blank box is how a tenant ends up with an approval
 * email that says less than the default did.
 *
 * There is no preview of a rendered message, and that is deliberate: rendering requires values,
 * values come from a real event, and a preview built from invented ones would show an
 * administrator a message the product will never send. What is checked instead is stronger — the
 * API refuses a template naming a placeholder its type does not provide, at save time, with the
 * same check the renderer makes at send time.
 */
export function NotificationTemplatesScreen({
  types,
  overrides,
  suppressions,
}: {
  readonly types: readonly NotificationTypeDescriptor[];
  readonly overrides: readonly NotificationTemplateOverride[];
  readonly suppressions: readonly SuppressedAddress[];
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();

  const [editing, setEditing] = useState<{
    typeKey: string;
    channel: string;
    locale: string;
    subject: string;
    bodyText: string;
    bodyHtml: string | null;
  } | null>(null);
  const [releasing, setReleasing] = useState(false);

  const overrideFor = (
    typeKey: string,
    channel: string,
    locale: string,
  ): NotificationTemplateOverride | undefined =>
    overrides.find(
      (row) => row.typeKey === typeKey && row.channel === channel && row.locale === locale,
    );

  const open = async (typeKey: string, channel: string, locale: string): Promise<void> => {
    const existing = overrideFor(typeKey, channel, locale);
    if (existing !== undefined) {
      setEditing({ ...existing });
      return;
    }
    // No override yet: start from what the product ships, so the editor is a change rather than
    // an empty box. Fetched through a server action rather than a route handler of its own,
    // because the access token lives in an `httpOnly` cookie and a browser fetch could not carry
    // it — the same reason every other read in this application happens on the server.
    const shipped = await loadShippedTemplate(typeKey, channel, locale);
    if (!shipped.ok) {
      toast.error(translate('admin.notificationTemplates.shippedUnavailable'));
      return;
    }
    setEditing({ typeKey, channel, locale, ...shipped.value });
  };

  const reset = async (typeKey: string, channel: string, locale: string): Promise<void> => {
    const result = await resetNotificationTemplate(typeKey, channel, locale);
    if (result.ok) {
      toast.success(translate('admin.notificationTemplates.reset'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  const release = async (address: string): Promise<void> => {
    setReleasing(true);
    const result = await releaseSuppressedAddress(address);
    setReleasing(false);
    if (result.ok) {
      toast.success(translate('admin.notificationTemplates.released'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  return (
    <AdminScreen
      titleKey="admin.notificationTemplates.title"
      descriptionKey="admin.notificationTemplates.description"
    >
      <ul className="flex flex-col gap-2">
        {types.map((type) => (
          <li key={type.key}>
            <Card className="flex flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 font-medium">{translate(labelKeyFor(type.key))}</span>
              {type.availableChannels.flatMap((channel) =>
                LOCALES.map((locale) => {
                  const customised = overrideFor(type.key, channel, locale) !== undefined;
                  return (
                    <span key={`${channel}-${locale}`} className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant={customised ? 'default' : 'outline'}
                        onClick={() => {
                          void open(type.key, channel, locale);
                        }}
                      >
                        {channel} · {locale}
                      </Button>
                      {customised && (
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => {
                            void reset(type.key, channel, locale);
                          }}
                        >
                          {translate('admin.notificationTemplates.resetAction')}
                        </Button>
                      )}
                    </span>
                  );
                }),
              )}
            </Card>
          </li>
        ))}
      </ul>

      <Card className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">
          {translate('admin.notificationTemplates.suppressions')}
        </h2>
        <p className="text-muted-foreground text-sm">
          {translate('admin.notificationTemplates.suppressionsHint')}
        </p>
        {suppressions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {translate('admin.notificationTemplates.noSuppressions')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {suppressions.map((entry) => (
              <li key={entry.address} className="flex flex-wrap items-center gap-3">
                {/* Masked, as the API serves it: a list of whole addresses is a copy of the
                    directory with an easier query. */}
                <span className="font-mono text-sm">{entry.address}</span>
                <Badge tone="warning">
                  {translate('admin.notificationTemplates.bounces', { count: entry.bounceCount })}
                </Badge>
                <span className="text-muted-foreground text-sm">{entry.lastReason}</span>
              </li>
            ))}
          </ul>
        )}

        <form
          className="flex flex-wrap items-end gap-3"
          action={(formData) => {
            const address = formData.get('address');
            void release(typeof address === 'string' ? address : '');
          }}
        >
          {/* The whole address, typed. The list above deliberately cannot supply it, so lifting a
              suppression is an act somebody performs knowingly rather than by clicking a row. */}
          <TextField
            name="address"
            type="email"
            label={translate('admin.notificationTemplates.releaseLabel')}
            hint={translate('admin.notificationTemplates.releaseHint')}
            required
          />
          <Button type="submit" variant="outline" disabled={releasing}>
            {translate('admin.notificationTemplates.release')}
          </Button>
        </form>
      </Card>

      {editing !== null && (
        <FormDialog
          title={translate('admin.notificationTemplates.editTitle')}
          open
          onClose={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
          onSubmit={async (formData) => {
            const result = await saveNotificationTemplate(
              editing.typeKey,
              editing.channel,
              editing.locale,
              {
                subject: text(formData, 'subject'),
                bodyText: text(formData, 'bodyText'),
                bodyHtml: optionalText(formData, 'bodyHtml') ?? null,
              },
            );
            return result;
          }}
        >
          <TextField
            name="subject"
            label={translate('admin.notificationTemplates.subject')}
            defaultValue={editing.subject}
            required
          />
          <TextAreaField
            name="bodyText"
            label={translate('admin.notificationTemplates.bodyText')}
            hint={translate('admin.notificationTemplates.placeholderHint')}
            defaultValue={editing.bodyText}
            required
          />
          <TextAreaField
            name="bodyHtml"
            label={translate('admin.notificationTemplates.bodyHtml')}
            hint={translate('admin.notificationTemplates.bodyHtmlHint')}
            defaultValue={editing.bodyHtml ?? ''}
          />
        </FormDialog>
      )}
    </AdminScreen>
  );
}
