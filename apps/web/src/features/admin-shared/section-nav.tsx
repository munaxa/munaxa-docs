'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { SidebarNav } from '@munaxa/ui';

import { useTranslate } from '../../app/providers';
import type { AdminSection } from '../../lib/admin/sections';

/**
 * The list of areas inside Administration.
 *
 * A second level rather than sixteen entries in the workspace's main navigation: the main menu is
 * where a person goes to *work*, and burying Documents and Approvals under a wall of configuration
 * screens would make the product look like a configuration tool.
 *
 * The sections arrive already filtered. Which areas exist for this caller is a permission question,
 * and permissions are the server's answer (`docs/architecture/08-permission-model.md` §7).
 */
export function AdminSectionNav({ sections }: { sections: readonly AdminSection[] }): ReactNode {
  const translate = useTranslate();
  const pathname = usePathname();

  const groups = sections.map((section) => ({
    id: section.id,
    title: translate(section.titleKey),
    items: section.destinations.map((destination) => ({
      id: destination.id,
      href: destination.href,
      label: translate(destination.titleKey),
      // Prefix match, so the folder tree inside a library still highlights Libraries.
      active: pathname === destination.href || pathname.startsWith(`${destination.href}/`),
    })),
  }));

  return (
    <SidebarNav
      groups={groups}
      label={translate('admin.sectionNav')}
      renderLink={({ href, className, children, ...rest }) => (
        // The platform hands `href` back as a plain string; the destinations were typed on the way
        // in (`lib/admin/sections.ts`), which is where a route that does not exist is caught.
        <Link href={href as Route} className={className} {...rest}>
          {children}
        </Link>
      )}
    />
  );
}
