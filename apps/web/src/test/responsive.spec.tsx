import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';

import { Providers } from '../app/providers';
import { DashboardScreen } from '../features/dashboard/dashboard-screen';
import { DocumentScreen } from '../features/documents/document-screen';
import { LibraryScreen } from '../features/documents/library-screen';
import { SearchScreen } from '../features/search/search-screen';
import { closeBrowser, renderPage } from './browser';
import {
  administratorDashboard,
  document as documentFixture,
  documentSummary,
  folder,
  library,
  listState,
  searchResults,
  userDashboard,
} from './fixtures';

/**
 * No screen overflows its viewport — Phase 7.1, at the six widths the brief names.
 *
 * ## Why this is a test rather than an inspection
 *
 * Horizontal overflow is the responsive defect that does not announce itself. Nothing throws, no
 * assertion fails, the page still renders; a reader on a phone simply finds the page sliding
 * sideways and half the toolbar off the edge. It is also the defect a CSS review cannot find,
 * because the cause is frequently nowhere near the symptom — the two this suite found on its first
 * run are the proof:
 *
 * - **The document record page overflowed by 198px at 390px**, and the cause was the content
 *   digest. Sixty-four hexadecimal characters have no break opportunity, so the string set the
 *   automatic minimum size of its grid item and the entire two-card row inherited a 588px floor.
 *   Nothing in the record page's own classes said 588 anywhere.
 * - **Search overflowed by 24px at 390px** — one unwrapping flex row, and the "Save search" button
 *   was the part that hung over the edge.
 *
 * Neither was visible in the desktop baselines, and neither would have been found by reading the
 * markup.
 *
 * ## What it does and does not cover
 *
 * Static server-rendered markup with the **real built stylesheet**, which is exactly right for
 * layout: overflow is a property of boxes and the cascade, and both are present here. What is not
 * present is hydration — so the *shell's* rail-versus-drawer choice, which is made by
 * `useMediaQuery`, is not covered here and is covered by the E2E suite against the running
 * application instead. The two are complementary and the split is deliberate.
 */

function markup(ui: ReactElement): string {
  return renderToStaticMarkup(
    <Providers session={{ userId: 'u', tenantId: 't', locale: 'en' }}>{ui}</Providers>,
  );
}

/** Desktop, laptop, tablet landscape, tablet, and two phones. */
const WIDTHS = [1440, 1280, 1024, 768, 430, 390] as const;

interface Culprit {
  readonly tag: string;
  readonly cls: string;
  readonly text: string;
}

const SURFACES: readonly { readonly name: string; readonly ui: () => ReactElement }[] = [
  {
    name: 'dashboard',
    ui: () => (
      <DashboardScreen
        user={userDashboard()}
        administrator={administratorDashboard()}
        recent={[documentSummary()]}
        favorites={[documentSummary()]}
      />
    ),
  },
  {
    name: 'document-list',
    ui: () => (
      <LibraryScreen
        rows={[documentSummary()]}
        total={1}
        state={listState()}
        libraries={[library()]}
        folders={[folder()]}
        selectedLibraryId={library().id}
        selectedFolderId={folder().id}
        selectedFolderName="Procedures"
        documentTypes={[]}
        categories={[]}
        confidentialityLevels={[]}
        users={[]}
        departments={[]}
        canCreate
        canBulk={{ edit: true, restore: true, download: true }}
      />
    ),
  },
  {
    name: 'document-record',
    ui: () => (
      <DocumentScreen
        document={documentFixture()}
        folders={[folder()]}
        categories={[]}
        confidentialityLevels={[]}
        users={[]}
        departments={[]}
        fields={[]}
        canEdit
        canMove
        canDownload
        canArchive
      />
    ),
  },
  {
    name: 'search',
    ui: () => (
      <SearchScreen
        queryText="manual"
        sort="relevance"
        filters={{}}
        initialResults={searchResults()}
        saved={[]}
        recent={[]}
        typeLabels={{}}
        categoryLabels={{}}
        departmentLabels={{}}
        entityLabels={{}}
      />
    ),
  },
];

afterAll(async () => {
  await closeBrowser();
});

describe.each(SURFACES)('$name', ({ ui }) => {
  it.each(WIDTHS)(
    'does not overflow at %ipx',
    async (width) => {
      const page = await renderPage(markup(ui()), { width, height: 900 });
      const result = await page.evaluate((viewportWidth: number) => {
        const culprits: Culprit[] = [];
        for (const element of Array.from(document.querySelectorAll('*'))) {
          const box = element.getBoundingClientRect();
          // Leaves only, and only the ones wide enough to be a layout problem rather than a stray
          // decorative pixel: an ancestor is over the edge because a descendant is, and naming the
          // ancestor sends the next reader to the wrong file.
          if (box.right > viewportWidth + 1 && box.width > 40 && element.children.length === 0) {
            culprits.push({
              tag: element.tagName.toLowerCase(),
              cls: (element.getAttribute('class') ?? '').slice(0, 60),
              text: (element.textContent ?? '').slice(0, 40),
            });
          }
        }
        return {
          overflow: Math.max(0, document.documentElement.scrollWidth - viewportWidth),
          culprits: culprits.slice(0, 3),
        };
      }, width);
      await page.close();

      expect(
        result.overflow,
        `overflows by ${String(result.overflow)}px — ${JSON.stringify(result.culprits)}`,
      ).toBe(0);
    },
    60_000,
  );
});
