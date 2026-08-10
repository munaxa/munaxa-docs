'use client';

import type { Route } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { Breadcrumb, Page, PageHeader, Stack } from '@munaxa/ui';

import { useTranslate } from '../app/providers';

/**
 * The frame every workspace screen sits in — Phase 7.
 *
 * `AdminScreen` has given the twenty administration screens a `Page` and a `PageHeader` since
 * Phase 2. Nothing outside `admin/` used either: the library and the approval inbox had no page
 * header at all, and seven other screens opened with a hand-written `<h1 className="text-2xl
 * font-semibold">`. Three consequences were visible on screen — the vertical rhythm changed when
 * you walked from Documents into Administration, the title size was set in nine places rather than
 * one, and there was nowhere consistent for a screen's own actions to sit.
 *
 * So this is `AdminScreen`'s composition, made available to the rest of the product. It is
 * deliberately *not* the same component: an administration screen takes message keys and always has
 * a description, while a workspace screen frequently has a title that is a document's own name and
 * a breadcrumb that is a path through a library. Sharing one component would have meant a
 * `titleKey | title` union on every caller.
 *
 * ## The breadcrumb
 *
 * `16-frontend-architecture.md` has called for contextual breadcrumbs since Phase 0 and the product
 * rendered none — the platform's `Breadcrumb` had **zero** uses. It goes in `PageHeader`'s `above`
 * slot, which exists for exactly this, so the crumb sits inside the header's rhythm rather than
 * being another thing stacked above it.
 *
 * The last crumb is the current page and carries no `href`, which is what makes it render as text
 * rather than as a link a reader can follow back to where they already are.
 */
export interface WorkspaceCrumb {
  readonly label: string;
  /** Absent on the last crumb — the page you are already on is not a link. */
  readonly href?: Route;
}

export function WorkspacePage({
  title,
  description,
  actions,
  breadcrumb,
  gap = 6,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly breadcrumb?: readonly WorkspaceCrumb[];
  readonly gap?: 4 | 6;
  readonly children: ReactNode;
}): ReactNode {
  const translate = useTranslate();

  return (
    <Page gap={gap}>
      <PageHeader
        title={title}
        {...(description !== undefined && { description })}
        {...(actions !== undefined && { actions })}
        {...(breadcrumb !== undefined &&
          breadcrumb.length > 0 && {
            above: (
              <Breadcrumb
                label={translate('nav.breadcrumb')}
                items={breadcrumb.map((crumb) => ({
                  label: crumb.label,
                  ...(crumb.href !== undefined && { href: crumb.href }),
                }))}
                // The platform hands `href` back as a plain string because it must not import a
                // router. The crumbs were typed as `Route` on the way in, which is where a bad
                // route is actually caught — the same arrangement `WorkspaceShell` uses for the
                // navigation rail.
                renderLink={({ href, className, children: linkChildren }) => (
                  <Link href={href as Route} className={className}>
                    {linkChildren}
                  </Link>
                )}
              />
            ),
          })}
      />
      <Stack gap={4}>{children}</Stack>
    </Page>
  );
}
