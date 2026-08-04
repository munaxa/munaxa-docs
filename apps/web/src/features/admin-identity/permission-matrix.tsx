'use client';

import { type ReactNode, useMemo, useState } from 'react';

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Checkbox,
  Field,
} from '@munaxa/ui';

import type { PermissionDescriptor } from '@edms/contracts';
import type { PermissionKey } from '@edms/domain';

import { useTranslate } from '../../app/providers';

/**
 * The permissions a role grants.
 *
 * Grouped by the `resource` half of `resource:action`, which the API sends rather than the client
 * splitting the string: the grouping is a product decision about how the matrix reads, and deriving it
 * from a substring here would make a renamed permission silently land in a group of its own.
 *
 * Controlled, because "grant all" and "revoke all" have to move every box at once, and because the
 * count in each group's heading has to follow. Each granted key posts as a `permission` field, so the
 * submit handler reads the list without knowing anything about this component.
 */
export function PermissionMatrix({
  catalogue,
  defaultValue,
  disabled,
}: {
  catalogue: readonly PermissionDescriptor[];
  defaultValue: readonly PermissionKey[];
  disabled?: boolean;
}): ReactNode {
  const translate = useTranslate();
  const [granted, setGranted] = useState<ReadonlySet<PermissionKey>>(new Set(defaultValue));

  const groups = useMemo(() => {
    const byResource = new Map<string, PermissionDescriptor[]>();
    for (const descriptor of catalogue) {
      const bucket = byResource.get(descriptor.resource);
      if (bucket === undefined) {
        byResource.set(descriptor.resource, [descriptor]);
      } else {
        bucket.push(descriptor);
      }
    }
    return [...byResource.entries()];
  }, [catalogue]);

  const toggle = (key: PermissionKey, on: boolean): void => {
    setGranted((current) => {
      const next = new Set(current);
      if (on) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  };

  return (
    <Field
      label={translate('admin.roles.permissions')}
      hint={translate('admin.roles.permissionsChanged')}
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setGranted(new Set(catalogue.map((descriptor) => descriptor.key)));
            }}
          >
            {translate('admin.roles.grantAll')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setGranted(new Set());
            }}
          >
            {translate('admin.roles.revokeAll')}
          </Button>
        </div>

        <Accordion type="multiple">
          {groups.map(([resource, descriptors]) => {
            const held = descriptors.filter((descriptor) => granted.has(descriptor.key)).length;
            return (
              <AccordionItem key={resource} value={resource}>
                <AccordionTrigger level={4}>
                  {resource} ·{' '}
                  {translate('admin.list.count', { count: held, total: descriptors.length })}
                </AccordionTrigger>
                <AccordionContent>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {descriptors.map((descriptor) => (
                      <Checkbox
                        key={descriptor.key}
                        checked={granted.has(descriptor.key)}
                        disabled={disabled}
                        onChange={(event) => {
                          toggle(descriptor.key, event.currentTarget.checked);
                        }}
                        label={
                          <span className="flex flex-col">
                            <span>{descriptor.action}</span>
                            {descriptor.survivesBrokenInheritance ? (
                              <span className="text-muted-foreground text-xs">
                                {translate('admin.permissions.alwaysReaches')}
                              </span>
                            ) : null}
                          </span>
                        }
                      />
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>

        {[...granted].map((key) => (
          <input key={key} type="hidden" name="permission" value={key} />
        ))}
      </div>
    </Field>
  );
}
