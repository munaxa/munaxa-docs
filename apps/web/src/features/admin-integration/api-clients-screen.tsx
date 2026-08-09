'use client';

import { type ReactNode, useState } from 'react';

import type { ApiClient, User } from '@edms/contracts';
import { ALL_API_SCOPES } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import { succeeded } from '../../lib/admin/action-result';
import type { ListState } from '../../lib/admin/list-state';
import {
  AdminScreen,
  CheckboxGroupField,
  FormDialog,
  PickerField,
  ResourceList,
  TextField,
  list,
  optionalText,
  text,
  useAdminColumns,
  useListNavigation,
} from '../admin-shared';
import { createApiClient, revokeApiClient } from './actions';
import { SecretOnce } from './secret-once';

/**
 * API clients — the credentials a machine caller presents.
 *
 * Three things on this screen are deliberate and each would look like an omission:
 *
 * **There is no edit.** A key's subject and scopes are what its holder was told they had, and
 * changing either silently changes what a running integration can do. Revoke and mint is one more
 * step and is a fact both sides can see.
 *
 * **A revoked key stays in the list**, greyed rather than removed. "Which keys existed, for whom,
 * and when were they withdrawn" is what an access review reads, and a row that vanished would take
 * the answer with it.
 *
 * **The subject column is the one to read**, not the name. A key acts *as* a person — every
 * document it can reach is one that person can reach — so "who is this key" is a more important
 * question than "what did somebody call it", and the column order says so.
 */
export function ApiClientsScreen({
  rows,
  total,
  state,
  people,
}: {
  rows: readonly ApiClient[];
  total: number;
  state: ListState;
  people: readonly User[];
}): ReactNode {
  const translate = useTranslate();
  const column = useAdminColumns<ApiClient>();
  const { refresh } = useListNavigation(state);
  const [creating, setCreating] = useState(false);
  /** The one moment a secret exists outside the holder's hands. Cleared when the dialogue closes. */
  const [minted, setMinted] = useState<{ name: string; secret: string } | null>(null);

  const nameOf = (id: string): string =>
    people.find((person) => person.id === id)?.displayName ?? id;

  return (
    <AdminScreen titleKey="admin.apiClients.title" descriptionKey="admin.apiClients.description">
      <ResourceList<ApiClient>
        rows={rows}
        total={total}
        state={state}
        getRowId={(row) => row.id}
        getRowName={(row) => row.name}
        isDeleted={(row) => row.revokedAt !== null}
        onCreate={() => {
          setCreating(true);
        }}
        // `DELETE` revokes, and the list renders it as a withdrawn row: `deletedAt` carries the
        // revocation instant, so the ordinary component needs no special case. There is no
        // restore — a revoked credential is withdrawn, not binned.
        onDelete={(row) => revokeApiClient(row.id, row.version)}
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
            id: 'subject',
            header: translate('admin.apiClients.subject'),
            width: 180,
            sortable: false,
            cell: (row) => nameOf(row.subjectUserId),
            value: (row) => nameOf(row.subjectUserId),
          },
          {
            id: 'scopes',
            header: translate('admin.apiClients.scopes'),
            width: 240,
            sortable: false,
            cell: (row) => row.scopes.join(', '),
            value: (row) => row.scopes.join(' '),
          },
          {
            // The visible selector, so an administrator can match a row to a key somebody is
            // holding without either of them revealing the secret.
            id: 'keyPrefix',
            header: translate('admin.apiClients.prefix'),
            width: 150,
            sortable: false,
            cell: (row) => `mdk.${row.keyPrefix}…`,
            value: (row) => row.keyPrefix,
          },
          {
            // Coarse by an hour, and the column says so in its hint rather than implying a
            // precision the write does not have.
            id: 'lastUsedAt',
            header: translate('admin.apiClients.lastUsed'),
            width: 150,
            sortable: false,
            cell: (row) => row.lastUsedAt ?? translate('admin.apiClients.neverUsed'),
            value: (row) => row.lastUsedAt ?? '',
          },
          column.state(),
        ]}
      />

      <FormDialog
        open={creating}
        title={translate('admin.apiClients.createTitle')}
        description={translate('admin.apiClients.createHint')}
        onClose={() => {
          setCreating(false);
        }}
        onSubmit={async (data) => {
          const result = await createApiClient({
            name: text(data, 'name'),
            description: optionalText(data, 'description'),
            subjectUserId: text(data, 'subjectUserId'),
            scopes: list(data, 'scopes'),
          });
          if (result.ok) {
            setMinted({ name: result.value.client.name, secret: result.value.secret });
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
          name="description"
          label={translate('admin.fields.description')}
          maxLength={500}
        />
        <PickerField
          name="subjectUserId"
          label={translate('admin.apiClients.subject')}
          hint={translate('admin.apiClients.subjectHint')}
          required
          options={people.map((person) => ({ value: person.id, label: person.displayName }))}
        />
        <CheckboxGroupField
          name="scopes"
          label={translate('admin.apiClients.scopes')}
          hint={translate('admin.apiClients.scopesHint')}
          choices={ALL_API_SCOPES.map((scope) => ({ value: scope, label: scope }))}
        />
      </FormDialog>

      <SecretOnce
        open={minted !== null}
        title={translate('admin.apiClients.mintedTitle')}
        description={translate('admin.apiClients.mintedHint')}
        secret={minted?.secret ?? ''}
        onClose={() => {
          setMinted(null);
        }}
      />
    </AdminScreen>
  );
}
