'use client';

import type { ReactNode } from 'react';

import { Badge, DataGrid, EmptyState } from '@munaxa/ui';

import type { PermissionDescriptor, Role } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import { AdminScreen } from '../admin-shared';

/**
 * The permission catalogue, and which roles grant each entry.
 *
 * Read-only, and not because the screen is unfinished: the catalogue is the product's definition of
 * what a permission *is*, and a permission absent from it does not exist — the API would refuse it in
 * a role. Making it editable would mean letting a tenant invent a permission nothing checks.
 *
 * The value it adds over the role editor is the other direction of the same matrix. "Who can approve"
 * is a question administrators ask constantly, and answering it by opening eight roles in turn is how
 * a permission ends up granted twice and revoked once.
 *
 * Rendered as a client-side grid rather than through `ResourceList`: the catalogue is a fixed list of
 * a few dozen rows that arrives whole, so paging it against the server would be a round trip to
 * re-sort something already in memory.
 */
export function PermissionsScreen({
  catalogue,
  roles,
}: {
  catalogue: readonly PermissionDescriptor[];
  roles: readonly Role[];
}): ReactNode {
  const translate = useTranslate();

  const grantedBy = (descriptor: PermissionDescriptor): readonly string[] =>
    roles
      .filter((role) => role.permissions.includes(descriptor.key))
      .map((role) => role.name)
      .sort();

  return (
    <AdminScreen titleKey="admin.permissions.title" descriptionKey="admin.permissions.description">
      <DataGrid<PermissionDescriptor>
        rows={[...catalogue]}
        getRowId={(row) => row.key}
        getRowLabel={(row) => row.key}
        mode="client"
        searchable
        paginated={false}
        height="60vh"
        rowHeight={56}
        aria-label={translate('admin.permissions.title')}
        labels={{
          search: translate('admin.list.search'),
          searchPlaceholder: translate('admin.list.searchPlaceholder'),
          columns: translate('admin.list.columns'),
          sortedAscending: translate('admin.grid.sortedAscending'),
          sortedDescending: translate('admin.grid.sortedDescending'),
          notSorted: translate('admin.grid.notSorted'),
          resizeColumn: (label) => translate('admin.grid.resizeColumn', { name: label }),
          rowCount: (count) => translate('admin.grid.rowCount', { count }),
          empty: translate('admin.list.empty'),
        }}
        emptyState={<EmptyState title={translate('admin.list.emptySearch')} />}
        columns={[
          {
            id: 'resource',
            header: translate('admin.permissions.resource'),
            width: 180,
            sortable: true,
            value: (row) => row.resource,
          },
          {
            id: 'action',
            header: translate('admin.permissions.action'),
            width: 180,
            sortable: true,
            rowHeader: true,
            value: (row) => row.action,
          },
          {
            id: 'key',
            header: translate('admin.fields.key'),
            width: 240,
            sortable: true,
            value: (row) => row.key,
          },
          {
            id: 'grantedTo',
            header: translate('admin.permissions.grantedTo'),
            multiline: true,
            value: (row) => grantedBy(row).join(', '),
            cell: (row) => {
              const names = grantedBy(row);
              return names.length === 0 ? (
                <span className="text-muted-foreground">{translate('admin.fields.no')}</span>
              ) : (
                <span className="flex flex-wrap gap-1">
                  {names.map((name) => (
                    <Badge key={name} tone="muted">
                      {name}
                    </Badge>
                  ))}
                </span>
              );
            },
          },
          {
            id: 'survives',
            header: translate('admin.permissions.alwaysReaches'),
            width: 160,
            multiline: true,
            value: (row) =>
              translate(row.survivesBrokenInheritance ? 'admin.fields.yes' : 'admin.fields.no'),
          },
        ]}
      />
    </AdminScreen>
  );
}
