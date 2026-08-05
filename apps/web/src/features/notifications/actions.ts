'use server';

import { savePreferenceSchema, saveQuietHoursSchema, saveTemplateSchema } from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminRead, adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Writes to somebody's notifications, and to a tenant's templates.
 *
 * Server actions, like every other write in this product, so the access token stays in its
 * `httpOnly` cookie and never reaches client JavaScript.
 *
 * **No recipient anywhere.** Nothing in this file names a user. Every route under
 * `/notifications` is about the caller's own inbox and reads the actor from the request context,
 * so there is no field here to carry somebody else's identifier and none for a client to invent —
 * the same enforcement-by-absence the delegation actions use for their delegator. That absence is
 * what makes "read somebody else's notifications" a request this application cannot make.
 *
 * The template actions are a different thing on the same module and go to a different controller:
 * they are tenant configuration behind `settings:manage`, and they change what everybody is told.
 */

export async function markNotificationRead(id: string): Promise<ActionResult> {
  return adminWrite({ path: `/notifications/${id}/read`, method: 'POST' });
}

export async function markAllNotificationsRead(): Promise<ActionResult<{ marked: number }>> {
  return adminWrite<{ marked: number }>({ path: '/notifications/read-all', method: 'POST' });
}

/** One type's channels and digest. Removing the row is a different action, below. */
export async function saveNotificationPreference(
  typeKey: string,
  input: unknown,
): Promise<ActionResult> {
  return validated(savePreferenceSchema, input, (body) =>
    adminWrite({ path: `/notifications/preferences/${typeKey}`, method: 'PUT', body }),
  );
}

/**
 * Returns a type to the product's defaults.
 *
 * A delete rather than a save of "the defaults", because a stored row that happens to equal them
 * today would stop equalling them the day the product changes its mind — and the person would
 * silently keep an opinion they never expressed.
 */
export async function clearNotificationPreference(typeKey: string): Promise<ActionResult> {
  return adminWrite({ path: `/notifications/preferences/${typeKey}`, method: 'DELETE' });
}

export async function saveQuietHours(input: unknown): Promise<ActionResult> {
  return validated(saveQuietHoursSchema, input, (body) =>
    adminWrite({ path: '/notifications/quiet-hours', method: 'PUT', body }),
  );
}

export async function clearQuietHours(): Promise<ActionResult> {
  return adminWrite({ path: '/notifications/quiet-hours', method: 'DELETE' });
}

// --- Tenant configuration, behind `settings:manage` --------------------------------------------

/**
 * The template the product ships for one `(type, channel, locale)`.
 *
 * A read through a server action rather than a route handler, because the access token lives in
 * an `httpOnly` cookie: a browser `fetch` could not carry it, and a route handler that proxied
 * the call would be a second copy of `adminGet`'s error handling. It is fetched on demand rather
 * than sent with the page, because the page would otherwise carry seventy-odd templates so that
 * an administrator could open one.
 */
export async function loadShippedTemplate(
  typeKey: string,
  channel: string,
  locale: string,
): Promise<ActionResult<{ subject: string; bodyText: string; bodyHtml: string | null }>> {
  return adminRead<{ subject: string; bodyText: string; bodyHtml: string | null }>(
    `/admin/notifications/templates/${typeKey}/${channel}/${locale}`,
  );
}

export async function saveNotificationTemplate(
  typeKey: string,
  channel: string,
  locale: string,
  input: unknown,
): Promise<ActionResult> {
  return validated(saveTemplateSchema, input, (body) =>
    adminWrite({
      path: `/admin/notifications/templates/${typeKey}/${channel}/${locale}`,
      method: 'PUT',
      body,
    }),
  );
}

/** Removing the override *is* the reset: the template the product ships applies again. */
export async function resetNotificationTemplate(
  typeKey: string,
  channel: string,
  locale: string,
): Promise<ActionResult> {
  return adminWrite({
    path: `/admin/notifications/templates/${typeKey}/${channel}/${locale}`,
    method: 'DELETE',
  });
}

/**
 * Resumes mail to an address the product stopped writing to (18 §7).
 *
 * The whole address, typed by an administrator who knows which one they corrected — the list
 * deliberately shows masked ones, so lifting a suppression is an act somebody performs knowingly
 * rather than by clicking a row.
 */
export async function releaseSuppressedAddress(address: string): Promise<ActionResult> {
  return adminWrite({
    path: '/admin/notifications/suppressions/release',
    method: 'POST',
    body: { address },
  });
}
