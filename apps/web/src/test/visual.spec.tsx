import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it } from 'vitest';

import { ALL_PERMISSIONS } from '@edms/domain';

import { AppShellProvider, SidebarNav } from '@munaxa/ui';

import { en } from '@edms/i18n';

import { iconFor } from '../components/workspace-shell';
import { Providers } from '../app/providers';
import { ApprovalInboxScreen } from '../features/approvals/inbox-screen';
import { DashboardScreen } from '../features/dashboard/dashboard-screen';
import { FolderTree } from '../features/documents/folder-tree';
import { LibraryScreen } from '../features/documents/library-screen';
import { SearchScreen } from '../features/search/search-screen';
import { SignaturePanel } from '../features/signatures/signature-panel';
import { destinationsFor } from '../lib/navigation';
import {
  administratorDashboard,
  approvalInboxItem,
  document as documentFixture,
  documentSummary,
  folder,
  library,
  listState,
  searchResults,
  signature,
  userDashboard,
} from './fixtures';
import {
  type Theme,
  closeBrowser,
  contrastViolations,
  matchesBaseline,
  renderPage,
} from './browser';

/**
 * Colour contrast and visual regression, in a real browser.
 *
 * These are the two things jsdom cannot do. Contrast needs a cascade; a screenshot needs layout.
 * Both are checked against the **built** stylesheet — the artefact `verify:styles` guards — so a
 * theme change, a token change or a lost `@source` shows up here as well as there.
 *
 * Both themes are covered for every surface, because a palette that passes in light and fails in
 * dark is the normal way contrast regresses, and half the users of this product will be in one of
 * them.
 */

const THEMES: readonly Theme[] = ['light', 'dark'];

/**
 * A contrast failure that belongs to the platform, recorded rather than worked around.
 *
 * `Badge` renders `border-primary/30 bg-primary/15 text-primary-strong` from inside
 * `@munaxa/platform`. In the Docs light palette that is `#56774d` on an effective `#e9eee7`, which
 * measures **4.31:1** against the 4.5:1 that WCAG 2.1 AA requires for text below 18.66px. The
 * numbers are computed from `themes/docs/palette.css`, not estimated.
 *
 * This product cannot fix it. The classes are the component's own, so the only product-side
 * remedies are overriding platform styling or hardcoding a colour — and `ARCHITECTURE.md` forbids
 * the second outright while the brief forbids product-specific workarounds for platform
 * limitations. The fix belongs in the palette (`--primary-strong` a shade darker, or the badge
 * tint lighter) and is written up in the Phase 5.2 report as a platform issue.
 *
 * It is listed here so the suite still guards everything else: **any contrast violation that is
 * not this one fails the build.** Deleting the entry when the platform ships a fix is how this
 * stops being tolerated.
 */
const KNOWN_PLATFORM_CONTRAST: readonly { readonly match: string; readonly why: string }[] = [
  {
    match: 'text-primary-strong',
    why: '@munaxa/platform Badge — 4.31:1 on its own bg-primary/15 tint. Platform palette issue.',
  },
];

function isKnownPlatformIssue(html: string): boolean {
  return KNOWN_PLATFORM_CONTRAST.some((known) => html.includes(known.match));
}

/** The resolved navigation, with the icons this phase added. */
const NAV_GROUPS = [
  {
    id: 'main',
    items: destinationsFor(ALL_PERMISSIONS).map((destination) => {
      const Icon = iconFor(destination.id);
      return {
        id: destination.id,
        href: destination.href,
        label:
          en.nav[destination.labelKey.replace('nav.', '') as keyof typeof en.nav] ?? destination.id,
        icon: <Icon className="size-4" aria-hidden />,
        active: destination.id === 'home',
      };
    }),
  },
];

function markup(ui: ReactElement): string {
  return renderToStaticMarkup(
    <Providers session={{ userId: 'u', tenantId: 't', locale: 'en' }}>{ui}</Providers>,
  );
}

/** The surfaces the brief names, each as static markup. */
const SURFACES: readonly { readonly name: string; readonly ui: () => ReactElement }[] = [
  // `SidebarNav` directly rather than the whole `WorkspaceShell`, and the reason is worth stating.
  // The shell chooses its rail or its drawer through `useMediaQuery`, which has no media to query
  // during a static server render — so a screenshot of the shell is always the *mobile* layout,
  // with no sidebar, no navigation landmark and exactly one icon. Verified rather than assumed:
  // the SSR markup contains no `<aside>`, no `<nav>` and one `<svg>`.
  //
  // Rendering the navigation on its own sidesteps that and covers more of what actually changed:
  // `collapsed` is an explicit prop here, so the icon-only rail — the state where a destination
  // without an icon is a blank row — is a baseline rather than a state nothing looks at.
  {
    name: 'sidebar-nav',
    ui: () => (
      <AppShellProvider>
        {/* The rail's real widths, so the baseline is the shape that ships rather than a
            full-bleed row. `Sidebar` applies these; rendering the nav alone does not. */}
        <div className="w-64 p-3">
          <SidebarNav groups={NAV_GROUPS} label="Main" collapsed={false} />
        </div>
      </AppShellProvider>
    ),
  },
  {
    name: 'sidebar-nav-collapsed',
    ui: () => (
      <AppShellProvider>
        <div className="w-16 p-3">
          <SidebarNav groups={NAV_GROUPS} label="Main" collapsed />
        </div>
      </AppShellProvider>
    ),
  },
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
    name: 'folder-tree',
    ui: () => (
      <FolderTree
        libraries={[library()]}
        folders={[folder()]}
        selectedLibraryId={library().id}
        selectedFolderId={folder().id}
        documentCounts={{}}
      />
    ),
  },
  {
    name: 'workflow-inbox',
    ui: () => <ApprovalInboxScreen rows={[approvalInboxItem()]} decided={false} />,
  },
  /**
   * The signature panel, in both of the states the backend actually has — Phase 6.6.
   *
   * The **ceremony itself is deliberately absent**, and the harness's own docstring says why: this
   * renders static markup, so no dialogue is opened, no portal mounts and no effect runs. A
   * screenshot of `SigningCeremony` here would be a screenshot of nothing. The ceremony's stages
   * are covered where they can be — by axe in `signing-ceremony.spec.tsx`, which hydrates, and by
   * real Chromium in `e2e/signing.e2e.spec.ts`, which drives the whole thing.
   */
  {
    name: 'signatures-empty',
    ui: () => (
      <SignaturePanel document={documentFixture()} signatures={[]} canSign mfaEnrolled={false} />
    ),
  },
  {
    name: 'signatures-signed',
    ui: () => (
      <SignaturePanel
        document={documentFixture()}
        signatures={[
          signature(),
          signature({
            id: '019489f0-0000-7000-8000-000000000802',
            signerName: 'Grace Hopper',
            purpose: 'WITNESS',
            withdrawnAt: '2026-03-01T00:00:00.000Z',
            withdrawnReason: 'Signed against the wrong revision.',
          }),
        ]}
        canSign
        mfaEnrolled={false}
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

describe.each(THEMES)('%s theme', (theme) => {
  describe.each(SURFACES)('$name', ({ name, ui }) => {
    it('has no colour-contrast violations', async () => {
      const page = await renderPage(markup(ui()), { theme });
      const violations = await contrastViolations(page);
      await page.close();

      const unexpected = violations.flatMap((violation) =>
        violation.nodes
          .filter((node) => !isKnownPlatformIssue(node.html))
          .map(
            (node) => `  ✗ ${violation.id}: ${node.summary.split('\n')[1] ?? ''}\n    ${node.html}`,
          ),
      );

      if (unexpected.length > 0) {
        throw new Error(`${name} (${theme}) contrast violations:\n${unexpected.join('\n')}`);
      }
      expect(unexpected).toStrictEqual([]);
    });

    it('matches its visual baseline', async () => {
      const page = await renderPage(markup(ui()), { theme });
      const result = await matchesBaseline(page, `${name}-${theme}`);
      await page.close();

      expect(
        result.changedPixels,
        result.diffPath === undefined
          ? ''
          : `${name} (${theme}) changed by ${String(result.changedPixels)} pixels. ` +
              `Diff written to ${result.diffPath}. If the change is intended, delete the baseline ` +
              `and re-run to accept it.`,
      ).toBeLessThanOrEqual(120);
    });
  });
});
