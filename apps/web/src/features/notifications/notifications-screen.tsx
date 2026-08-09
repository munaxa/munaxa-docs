'use client';

import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Badge, Button, Card, Checkbox, EmptyState, Input, Select, useToast } from '@munaxa/ui';

import type {
  InboxNotification,
  NotificationPreference,
  NotificationTypeDescriptor,
  QuietHours,
} from '@edms/contracts';
import { DigestFrequency, NotificationChannel } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import { WorkspacePage } from '../../components/workspace-page';
import {
  clearNotificationPreference,
  clearQuietHours,
  markAllNotificationsRead,
  markNotificationRead,
  saveNotificationPreference,
  saveQuietHours,
} from './actions';
import { labelKeyFor } from './type-labels';

/**
 * The notification centre — 16 §2's `notifications/`, and the screen the brief asks for.
 *
 * Two things on one route, because they are two halves of one question. The **inbox** is what the
 * product has told this person; the **preferences** are what it will tell them next. Splitting
 * them would put "why am I getting these" one navigation away from the answer, which is where
 * nobody looks.
 *
 * It is deliberately **not** under `/admin`. 18 §5's preferences are per *user* — "per type, a
 * user chooses: immediate, digest, or off (where allowed); plus quiet hours with a timezone" —
 * and an administration screen is where somebody configures the tenant. Template editing, which
 * genuinely is tenant configuration, lives under `/admin/notification-templates` instead.
 *
 * Reads happen in the server component that renders this; writes go through server actions. The
 * unread filter is a search parameter rather than component state, so a filtered view is a link.
 */
export function NotificationsScreen({
  notifications,
  unreadCount,
  unreadOnly,
  types,
  preferences,
  quietHours,
}: {
  readonly notifications: readonly InboxNotification[];
  readonly unreadCount: number;
  readonly unreadOnly: boolean;
  readonly types: readonly NotificationTypeDescriptor[];
  readonly preferences: readonly NotificationPreference[];
  readonly quietHours: QuietHours | null;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();

  const [working, setWorking] = useState(false);
  const [showPreferences, setShowPreferences] = useState(false);

  const filter = (next: boolean): void => {
    const search = new URLSearchParams(params.toString());
    if (next) {
      search.set('unread', 'true');
    } else {
      search.delete('unread');
    }
    router.push(`${pathname}?${search.toString()}` as Route);
  };

  const read = async (id: string): Promise<void> => {
    setWorking(true);
    const result = await markNotificationRead(id);
    setWorking(false);
    if (result.ok) {
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  const readAll = async (): Promise<void> => {
    setWorking(true);
    const result = await markAllNotificationsRead();
    setWorking(false);
    if (result.ok) {
      toast.success(translate('notifications.allRead'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  return (
    <WorkspacePage
      title={translate('notifications.title')}
      description={translate('notifications.subtitle')}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Select
          aria-label={translate('notifications.filter.label')}
          value={unreadOnly ? 'unread' : 'all'}
          onChange={(event) => {
            filter(event.currentTarget.value === 'unread');
          }}
        >
          <option value="all">{translate('notifications.filter.all')}</option>
          <option value="unread">{translate('notifications.filter.unread')}</option>
        </Select>

        <Badge tone={unreadCount > 0 ? 'default' : 'muted'}>
          {translate('notifications.unreadCount', { count: unreadCount })}
        </Badge>

        <div className="ms-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={working || unreadCount === 0}
            onClick={() => {
              void readAll();
            }}
          >
            {translate('notifications.markAllRead')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setShowPreferences((open) => !open);
            }}
          >
            {translate('notifications.preferences.toggle')}
          </Button>
        </div>
      </div>

      {showPreferences && (
        <PreferencesPanel types={types} preferences={preferences} quietHours={quietHours} />
      )}

      {notifications.length === 0 ? (
        <EmptyState
          title={translate(unreadOnly ? 'notifications.emptyUnread' : 'notifications.empty')}
          description={translate('notifications.emptyHint')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {notifications.map((notification) => (
            <li key={notification.id}>
              <Card className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1 font-medium">{notification.subject}</span>
                  {notification.readAt === null && (
                    <Badge>{translate('notifications.unread')}</Badge>
                  )}
                  <time className="text-muted-foreground text-sm" dateTime={notification.createdAt}>
                    {new Date(notification.createdAt).toLocaleString()}
                  </time>
                  {notification.readAt === null && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={working}
                      onClick={() => {
                        void read(notification.id);
                      }}
                    >
                      {translate('notifications.markRead')}
                    </Button>
                  )}
                </div>
                {/*
                  The plain-text body, which is what the API serves. An in-app notification is
                  rendered inside the product's own shell, and injecting provider-shaped HTML for
                  the sake of a paragraph tag would be an XSS vector for a formatting nicety.
                */}
                <p className="text-muted-foreground text-sm whitespace-pre-line">
                  {notification.body}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </WorkspacePage>
  );
}

/**
 * 18 §5, as a form.
 *
 * One row per notification type, and each row offers exactly what the type allows: a mandatory
 * type's channels may be chosen but not all cleared, a non-digestible one offers no digest, and a
 * channel with no template for that type is not offered at all. Every one of those constraints is
 * computed on the server from the catalogue and arrives on the descriptor — a client that decided
 * which types were silenceable would be deciding whether it could silence a security warning.
 *
 * Quiet hours sit above the list rather than inside it, because they are a property of the person
 * rather than of a type: nobody wants to be quiet for approvals and loud for publications at three
 * in the morning.
 */
function PreferencesPanel({
  types,
  preferences,
  quietHours,
}: {
  readonly types: readonly NotificationTypeDescriptor[];
  readonly preferences: readonly NotificationPreference[];
  readonly quietHours: QuietHours | null;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const [working, setWorking] = useState<string | null>(null);

  const stored = new Map(preferences.map((preference) => [preference.typeKey, preference]));

  const apply = async (
    typeKey: string,
    channels: readonly string[],
    digest: string,
  ): Promise<void> => {
    setWorking(typeKey);
    const result = await saveNotificationPreference(typeKey, { channels, digest });
    setWorking(null);
    if (result.ok) {
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  const reset = async (typeKey: string): Promise<void> => {
    setWorking(typeKey);
    const result = await clearNotificationPreference(typeKey);
    setWorking(null);
    if (result.ok) {
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  return (
    <Card className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{translate('notifications.preferences.title')}</h2>
      <p className="text-muted-foreground text-sm">{translate('notifications.preferences.hint')}</p>

      <QuietHoursForm quietHours={quietHours} />

      <ul className="flex flex-col gap-3">
        {types.map((type) => {
          const preference = stored.get(type.key);
          const chosen = preference?.channels ?? type.defaultChannels;
          const digest = preference?.digest ?? DigestFrequency.IMMEDIATE;

          return (
            <li key={type.key} className="flex flex-wrap items-center gap-3 border-t pt-3">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{translate(labelKeyFor(type.key))}</span>
                {type.mandatory && (
                  <Badge tone="warning">{translate('notifications.mandatory')}</Badge>
                )}
              </span>

              {type.availableChannels.map((channel) => (
                <Checkbox
                  key={channel}
                  checked={chosen.includes(channel)}
                  disabled={working !== null}
                  label={translate(
                    channel === NotificationChannel.EMAIL
                      ? 'notifications.channel.email'
                      : 'notifications.channel.inApp',
                  )}
                  onChange={(event) => {
                    const updated = event.currentTarget.checked
                      ? [...new Set([...chosen, channel])]
                      : chosen.filter((entry) => entry !== channel);
                    void apply(type.key, updated, digest);
                  }}
                />
              ))}

              {/*
                Offered only where a digest is allowed. An urgent type going into a daily rollup
                would be an approval deadline somebody hears about the morning after it passed.
              */}
              {type.digestible && (
                <Select
                  aria-label={translate('notifications.digest.label')}
                  value={digest}
                  disabled={working !== null}
                  onChange={(event) => {
                    void apply(type.key, chosen, event.currentTarget.value);
                  }}
                >
                  <option value={DigestFrequency.IMMEDIATE}>
                    {translate('notifications.digest.immediate')}
                  </option>
                  <option value={DigestFrequency.HOURLY}>
                    {translate('notifications.digest.hourly')}
                  </option>
                  <option value={DigestFrequency.DAILY}>
                    {translate('notifications.digest.daily')}
                  </option>
                  <option value={DigestFrequency.WEEKLY}>
                    {translate('notifications.digest.weekly')}
                  </option>
                </Select>
              )}

              {preference !== undefined && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={working !== null}
                  onClick={() => {
                    void reset(type.key);
                  }}
                >
                  {translate('notifications.preferences.reset')}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Quiet hours: two clock times and a zone, because that is what the rule is about. */
function QuietHoursForm({ quietHours }: { readonly quietHours: QuietHours | null }): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const [working, setWorking] = useState(false);
  const [start, setStart] = useState(toClock(quietHours?.startMinute ?? 22 * 60));
  const [end, setEnd] = useState(toClock(quietHours?.endMinute ?? 7 * 60));

  const save = async (): Promise<void> => {
    setWorking(true);
    const result = await saveQuietHours({
      startMinute: toMinutes(start),
      endMinute: toMinutes(end),
      // The browser's own zone, which is the zone the person setting a clock time meant. Sending
      // an offset instead would be wrong twice a year.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    setWorking(false);
    if (result.ok) {
      toast.success(translate('notifications.quietHours.saved'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  const clear = async (): Promise<void> => {
    setWorking(true);
    const result = await clearQuietHours();
    setWorking(false);
    if (result.ok) {
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        {translate('notifications.quietHours.from')}
        <Input
          type="time"
          value={start}
          onChange={(event) => {
            setStart(event.currentTarget.value);
          }}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {translate('notifications.quietHours.to')}
        <Input
          type="time"
          value={end}
          onChange={(event) => {
            setEnd(event.currentTarget.value);
          }}
        />
      </label>
      <Button
        type="button"
        disabled={working}
        onClick={() => {
          void save();
        }}
      >
        {translate('notifications.quietHours.save')}
      </Button>
      {quietHours !== null && (
        <Button
          type="button"
          variant="outline"
          disabled={working}
          onClick={() => {
            void clear();
          }}
        >
          {translate('notifications.quietHours.clear')}
        </Button>
      )}
      <p className="text-muted-foreground w-full text-sm">
        {translate('notifications.quietHours.hint')}
      </p>
    </div>
  );
}

function toClock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function toMinutes(clock: string): number {
  const [hours = '0', minutes = '0'] = clock.split(':');
  return Number(hours) * 60 + Number(minutes);
}
