'use client';

import { type ReactNode, useState } from 'react';

import type { WebhookEndpoint } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import { succeeded } from '../../lib/admin/action-result';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  FormDialog,
  ResourceList,
  SwitchField,
  TextField,
  changedFields,
  flag,
  isEmptyPatch,
  optionalText,
  text,
  unchanged,
  useListNavigation,
} from '../admin-shared';
import { createWebhook, deleteWebhook, updateWebhook } from './actions';
import { SecretOnce } from './secret-once';

/**
 * Outbound webhook endpoints.
 *
 * The column that matters is **failures**, not the name — an administrator opens this screen
 * because something is not arriving, and the two facts that answer it are how many consecutive
 * failures an endpoint has and whether the product has given up on it. Both are shown, and a
 * disabled endpoint says *why* rather than merely being off.
 *
 * The event list is free text and empty means everything, which is the default and is argued in
 * `webhookSubscribes`: an empty list subscribing to *nothing* would make the useful configuration
 * the one somebody has to get right, and a later phase's new event family would reach nobody until
 * every tenant edited every endpoint.
 */
export function WebhooksScreen({
  rows,
  total,
  state,
}: {
  rows: readonly WebhookEndpoint[];
  total: number;
  state: ListState;
}): ReactNode {
  const translate = useTranslate();
  const { refresh } = useListNavigation(state);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);
  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<string | null>(null);

  return (
    <AdminScreen titleKey="admin.webhooks.title" descriptionKey="admin.webhooks.description">
      <ResourceList<WebhookEndpoint>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={() => false}
        onCreate={() => {
          setCreating(true);
        }}
        onEdit={(row) => {
          setEditing(row);
        }}
        onDelete={(row) => deleteWebhook(row.id)}
        // Nothing is restorable here: a revoked key is withdrawn rather than binned, and a deleted
        // endpoint is gone. The prop is required by the list, so it answers success and writes
        // nothing — the row it would restore is never rendered as restorable.
        onRestore={() => Promise.resolve(succeeded(undefined))}
        columns={[
          {
            id: 'name',
            header: translate('admin.fields.name'),
            sortable: false,
            rowHeader: true,
            value: (row) => row.name,
          },
          {
            id: 'url',
            header: translate('admin.webhooks.url'),
            width: 280,
            sortable: false,
            value: (row) => row.url,
          },
          {
            id: 'eventTypes',
            header: translate('admin.webhooks.events'),
            width: 200,
            sortable: false,
            cell: (row) =>
              row.eventTypes.length === 0
                ? translate('admin.webhooks.allEvents')
                : row.eventTypes.join(', '),
            value: (row) => row.eventTypes.join(' '),
          },
          {
            id: 'failureCount',
            header: translate('admin.webhooks.failures'),
            width: 120,
            sortable: false,
            // The consecutive run, which is what "is this endpoint dead now" means — a success
            // resets it. A lifetime total would keep an endpoint looking unwell for ever.
            cell: (row) => String(row.failureCount),
            value: (row) => String(row.failureCount),
          },
          {
            id: 'enabled',
            header: translate('admin.webhooks.state'),
            width: 220,
            sortable: false,
            // A disabled endpoint says *why*. "Off" alone would leave somebody hunting for whether
            // they turned it off or the product did.
            cell: (row) =>
              row.enabled
                ? translate('admin.webhooks.enabled')
                : (row.disabledReason ?? translate('admin.webhooks.disabled')),
            value: (row) => (row.enabled ? 'enabled' : 'disabled'),
          },
        ]}
      />

      <FormDialog
        open={creating}
        title={translate('admin.webhooks.createTitle')}
        description={translate('admin.webhooks.createHint')}
        onClose={() => {
          setCreating(false);
        }}
        onSubmit={async (data) => {
          const result = await createWebhook({
            name: text(data, 'name'),
            url: text(data, 'url'),
            eventTypes: splitEvents(optionalText(data, 'eventTypes')),
            enabled: flag(data, 'enabled'),
          });
          if (result.ok) {
            setMinted(result.value.secret);
          }
          return result;
        }}
        onSaved={() => {
          setCreating(false);
          refresh();
        }}
      >
        <TextField name="name" label={translate('admin.fields.name')} required maxLength={120} />
        <TextField
          name="url"
          label={translate('admin.webhooks.url')}
          hint={translate('admin.webhooks.urlHint')}
          required
          maxLength={2000}
        />
        <TextField
          name="eventTypes"
          label={translate('admin.webhooks.events')}
          hint={translate('admin.webhooks.eventsHint')}
          maxLength={500}
        />
        <SwitchField name="enabled" label={translate('admin.webhooks.enabled')} defaultChecked />
      </FormDialog>

      {editing !== null && (
        <FormDialog
          open
          title={translate('admin.webhooks.editTitle')}
          onClose={() => {
            setEditing(null);
          }}
          onSubmit={(data) => {
            const patch = changedFields(
              {
                name: editing.name,
                url: editing.url,
                eventTypes: [...editing.eventTypes],
                enabled: editing.enabled,
              },
              {
                name: text(data, 'name'),
                url: text(data, 'url'),
                eventTypes: splitEvents(optionalText(data, 'eventTypes')),
                enabled: flag(data, 'enabled'),
              },
            );
            // A dialogue closed without a change writes nothing rather than bumping the version —
            // which would otherwise make a no-op edit conflict with somebody else's real one.
            return isEmptyPatch(patch)
              ? unchanged()
              : updateWebhook(editing.id, editing.version, patch);
          }}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        >
          <TextField
            name="name"
            label={translate('admin.fields.name')}
            required
            maxLength={120}
            defaultValue={editing.name}
          />
          <TextField
            name="url"
            label={translate('admin.webhooks.url')}
            hint={translate('admin.webhooks.urlHint')}
            required
            maxLength={2000}
            defaultValue={editing.url}
          />
          <TextField
            name="eventTypes"
            label={translate('admin.webhooks.events')}
            hint={translate('admin.webhooks.eventsHint')}
            maxLength={500}
            defaultValue={editing.eventTypes.join(', ')}
          />
          <SwitchField
            name="enabled"
            label={translate('admin.webhooks.enabled')}
            hint={translate('admin.webhooks.reenableHint')}
            defaultChecked={editing.enabled}
          />
        </FormDialog>
      )}

      <SecretOnce
        open={minted !== null}
        title={translate('admin.webhooks.mintedTitle')}
        description={translate('admin.webhooks.mintedHint')}
        secret={minted ?? ''}
        onClose={() => {
          setMinted(null);
        }}
      />
    </AdminScreen>
  );
}

/** Comma or whitespace separated, because both are what somebody types into one box. */
function splitEvents(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
