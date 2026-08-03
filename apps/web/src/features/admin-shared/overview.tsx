'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { Card, CardDescription, CardTitle, Page, PageHeader, Section } from '@munaxa/ui';

import { useTranslate } from '../../app/providers';
import type { AdminSection } from '../../lib/admin/sections';

/**
 * The index of Administration.
 *
 * It exists because the sidebar shows sixteen names and nothing else, and a name is not enough to
 * pick from when the areas are as interdependent as these. Each card carries the area's own sentence,
 * and the order is the order they need setting up in: numbering and confidentiality before document
 * types, because a document type cannot be created without both.
 */
export function AdminOverview({ sections }: { sections: readonly AdminSection[] }): ReactNode {
  const translate = useTranslate();

  return (
    <Page gap={6}>
      <PageHeader title={translate('admin.title')} description={translate('admin.subtitle')} />
      {sections.map((section) => (
        <Section key={section.id} title={translate(section.titleKey)}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {section.destinations.map((destination) => (
              <Link
                key={destination.id}
                href={destination.href}
                className="focus-visible:ring-ring rounded-lg focus-visible:ring-2 focus-visible:outline-none"
              >
                <Card className="hover:border-ring h-full p-4 transition-colors">
                  <CardTitle className="text-base">{translate(destination.titleKey)}</CardTitle>
                  <CardDescription>{translate(destination.descriptionKey)}</CardDescription>
                </Card>
              </Link>
            ))}
          </div>
        </Section>
      ))}
    </Page>
  );
}
