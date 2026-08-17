import { describe, it } from 'vitest';

import { LoginForm } from '../app/(auth)/login/login-form';
import { ApprovalInboxScreen } from './approvals/inbox-screen';
import { DashboardScreen } from './dashboard/dashboard-screen';
import { LibraryScreen } from './documents/library-screen';
import { FolderTree } from './documents/folder-tree';
import { DocumentScreen } from './documents/document-screen';
import { SearchScreen } from './search/search-screen';
import { SignaturePanel } from './signatures/signature-panel';
import { expectAccessible } from '../test/a11y';
import {
  administratorDashboard,
  approvalInboxItem,
  bareDocumentSummary,
  document as documentFixture,
  documentSummary,
  folder,
  library,
  listState,
  searchResults,
  signature,
  userDashboard,
} from '../test/fixtures';

/**
 * The workspace screens, checked by axe against a rendered tree.
 *
 * Every screen is asserted **twice** — populated and empty — because they are different markup.
 * An empty list renders an `EmptyState` where a populated one renders a table, and the branch that
 * only appears when there is nothing to show is exactly the one nobody looks at.
 *
 * What axe cannot judge here is colour contrast: jsdom has no cascade, so the rule is switched off
 * on the record in `test/a11y.tsx` and checked in a real browser instead. Everything else the brief
 * names — labels, invalid ARIA, headings, landmarks, duplicate ids — is live.
 */

const LABELS = {
  typeLabels: { manual: 'Manual' },
  categoryLabels: { quality: 'Quality' },
  departmentLabels: { qa: 'Quality Assurance' },
  entityLabels: { munaxa: 'Munaxa' },
} as const;

describe('document library', () => {
  const props = {
    total: 2,
    state: listState(),
    libraries: [library()],
    folders: [folder()],
    selectedLibraryId: library().id,
    selectedFolderId: folder().id,
    selectedFolderName: 'Procedures',
    documentTypes: [],
    categories: [],
    confidentialityLevels: [],
    users: [],
    departments: [],
    canCreate: true,
    canBulk: { edit: true, restore: true, download: true },
    // A folder's contents — the view every one of these fixtures describes.
    view: 'folder' as const,
  };

  it('is accessible with rows', async () => {
    await expectAccessible(
      <LibraryScreen {...props} rows={[documentSummary(), bareDocumentSummary()]} />,
    );
  });

  it('is accessible when empty', async () => {
    await expectAccessible(<LibraryScreen {...props} rows={[]} total={0} />);
  });

  it('is accessible without create or bulk rights', async () => {
    // The capability-gated branch. Affordances the caller may not use must be absent rather than
    // disabled-and-unlabelled.
    await expectAccessible(
      <LibraryScreen
        {...props}
        rows={[documentSummary()]}
        canCreate={false}
        canBulk={{ edit: false, restore: false, download: false }}
      />,
    );
  });
});

describe('folder tree', () => {
  it('is accessible with a selected folder', async () => {
    await expectAccessible(
      <FolderTree
        libraries={[library()]}
        folders={[
          folder(),
          folder({ id: '019489f0-0000-7000-8000-000000000202', name: 'Forms', path: '/Forms' }),
        ]}
        selectedLibraryId={library().id}
        selectedFolderId={folder().id}
        documentCounts={{}}
      />,
    );
  });

  it('is accessible with no library chosen', async () => {
    await expectAccessible(
      <FolderTree
        libraries={[library()]}
        folders={[]}
        selectedLibraryId={null}
        selectedFolderId={null}
        documentCounts={{}}
      />,
    );
  });
});

describe('approval inbox', () => {
  it('is accessible with pending tasks', async () => {
    await expectAccessible(<ApprovalInboxScreen rows={[approvalInboxItem()]} decided={false} />);
  });

  it('is accessible with a delegated task', async () => {
    // `onBehalfOf` renders an extra badge and a second name; a branch with its own markup.
    await expectAccessible(
      <ApprovalInboxScreen
        rows={[
          approvalInboxItem({
            onBehalfOf: {
              delegationId: '019489f0-0000-7000-8000-000000000501',
              delegatorId: '019489f0-0000-7000-8000-00000000000b',
              delegatorName: 'Other Person',
            },
          }),
        ]}
        decided={false}
      />,
    );
  });

  it('is accessible when empty', async () => {
    await expectAccessible(<ApprovalInboxScreen rows={[]} decided={false} />);
  });
});

describe('search', () => {
  const props = {
    queryText: '',
    sort: 'relevance',
    filters: {},
    saved: [],
    recent: [],
    ...LABELS,
  };

  it('is accessible before a search has been run', async () => {
    await expectAccessible(<SearchScreen {...props} initialResults={null} />);
  });

  it('is accessible with no matches', async () => {
    await expectAccessible(
      <SearchScreen {...props} queryText="nothing" initialResults={searchResults()} />,
    );
  });
});

describe('dashboard', () => {
  it('is accessible with every tile ready', async () => {
    await expectAccessible(
      <DashboardScreen
        user={userDashboard()}
        administrator={administratorDashboard()}
        recent={[documentSummary()]}
        favorites={[documentSummary()]}
      />,
    );
  });

  it('is accessible when the administrator tiles are refused', async () => {
    // A tile the caller may not see renders a different body. `anyGranted: false` removes the
    // administrator section entirely, which is the branch most callers actually get.
    await expectAccessible(
      <DashboardScreen
        user={userDashboard()}
        administrator={administratorDashboard({ anyGranted: false })}
        recent={[]}
        favorites={[]}
      />,
    );
  });
});

/**
 * The record page and its sections — Phase 7.2, and a screen this suite had never rendered.
 *
 * It is here now because Phase 7.2 changed what those sections *are*. Each was a `Card` with a
 * hand-written heading; each is now a platform `Panel`, which claims a `role="region"` labelled by
 * its own title. That is a landmark change on the product's most important screen, and a landmark
 * change is precisely the kind axe can settle and a reading of the source cannot: an unlabelled
 * region, a duplicated accessible name or a heading level skipped between the page title and a
 * section title would all pass review and fail here.
 */
describe('document record', () => {
  it('is accessible with its sections rendered', async () => {
    await expectAccessible(
      <DocumentScreen
        document={documentFixture()}
        canEdit
        canMove
        canDownload
        canArchive
        signatures={
          <SignaturePanel
            document={documentFixture()}
            signatures={[signature()]}
            canSign
            mfaEnrolled={false}
          />
        }
      />,
    );
  });

  it('is accessible with no file and no sections', async () => {
    // The branch a reader gets on a record whose content has not been uploaded yet: the File panel
    // renders a sentence instead of a description list, and every slot is empty.
    await expectAccessible(
      <DocumentScreen
        document={documentFixture({ currentRevision: null, latestRevision: null })}
        canEdit={false}
        canMove={false}
        canDownload={false}
      />,
    );
  });
});

describe('sign-in', () => {
  it('is accessible', async () => {
    await expectAccessible(<LoginForm next="/" />);
  });
});
