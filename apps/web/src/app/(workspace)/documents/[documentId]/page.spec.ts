import { DomainError, ErrorCode, Permission, type PermissionKey } from '@edms/domain';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What the document record page hands the signature panel when the read fails — Slice 25.
 *
 * `GET /documents/:id/signatures` is deliberately not render-critical: an outage leaves the panel
 * degraded rather than taking the whole record down, which is the posture the preview manifest
 * takes beside it. What it must not do is degrade into a *claim*. The panel renders `[]` as
 * "Nobody has signed this revision.", and a controlled document under ADR-0017 saying that because
 * nobody could ask is the mistake `documents-read-dependency.md` recorded when a refused permission
 * read rendered `entries: []`.
 *
 * So the swallow yields `null`, and this pins it. A render test cannot see the difference — both
 * values render a short grey sentence — so the assertion is the prop, which is the thing that
 * changed.
 */

const { adminAccess, adminGet } = vi.hoisted(() => ({
  adminAccess:
    vi.fn<
      (
        permission: PermissionKey,
      ) => Promise<{ readonly granted: boolean; readonly permissions: readonly PermissionKey[] }>
    >(),
  adminGet: vi.fn<(path: string) => Promise<unknown>>(),
}));

vi.mock('../../../../lib/admin/api', () => ({ adminAccess, adminGet }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

/** The panels are slots; this suite is about what the page passes, not what they draw. */
vi.mock('../../../../features/signatures/signature-panel', () => ({
  SignaturePanel: (props: unknown) => ({ type: 'SignaturePanel', props }),
}));
vi.mock('../../../../features/preview/preview-panel', () => ({ PreviewPanel: () => null }));
vi.mock('../../../../features/approvals/approval-panel', () => ({ ApprovalPanel: () => null }));
vi.mock('../../../../features/revisions/revision-panel', () => ({ RevisionPanel: () => null }));
vi.mock('../../../../features/audit/audit-timeline', () => ({ AuditTimeline: () => null }));
vi.mock('../../../../features/admin-shared', () => ({
  AdminForbidden: () => null,
  RateLimited: () => null,
}));
/*
 * Every panel is stubbed, and not only for isolation: the `logic` project has no `server-only`
 * alias — `a11y` and `browser` carry one — so a real screen reaching `lib/server-i18n` through its
 * server actions cannot resolve under this project at all. Stubbing the slots keeps the suite about
 * what the page passes, which is what changed.
 */
vi.mock('../../../../features/documents/document-screen', () => ({
  DocumentScreen: (props: Record<string, unknown>) => props,
}));

const { default: DocumentRecordPage } = await import('./page');

const DOCUMENT = '019489f0-0000-7000-8000-000000000001';

const VIEWER = [Permission.DOCUMENT_VIEW] as const;

/** Renders the page with the signature read behaving as `behaviour` says. */
async function signaturesProp(behaviour: 'answers' | 'fails'): Promise<unknown> {
  adminAccess.mockResolvedValue({ granted: true, permissions: VIEWER });
  adminGet.mockImplementation((path: string) => {
    if (path.endsWith('/signatures')) {
      return behaviour === 'fails'
        ? Promise.reject(new DomainError(ErrorCode.INTERNAL, 'Upstream is unavailable'))
        : Promise.resolve([]);
    }
    if (path.endsWith('/preview')) {
      return Promise.resolve(null);
    }
    if (path.endsWith('/workflow')) {
      return Promise.resolve({ stages: [] });
    }
    if (path === '/auth/mfa') {
      return Promise.resolve({ enrolled: false });
    }
    return Promise.resolve({ id: DOCUMENT, title: 'Quality Manual', latestRevision: null });
  });

  /*
   * The page returns the `DocumentScreen` **element**, not the mock's return value — JSX builds an
   * element and never calls the component — so the props are two elements deep: the screen's
   * `signatures` slot holds a `SignaturePanel` element whose own props carry the list.
   */
  const screen = (await DocumentRecordPage({
    params: Promise.resolve({ documentId: DOCUMENT }),
  })) as { props: { signatures: { props: Record<string, unknown> } } };

  return screen.props.signatures.props['signatures'];
}

beforeEach(() => {
  adminAccess.mockReset();
  adminGet.mockReset();
});

describe('the signature list the record page hands down', () => {
  it('is the empty list when the record answers with one', async () => {
    // The positive state first: an empty list must still reach the panel as an empty list, or the
    // assertion below would hold just as well if the page had stopped passing anything at all.
    expect(await signaturesProp('answers')).toEqual([]);
  });

  it('is null when the read did not answer, never an empty list', async () => {
    /*
     * The defect. `.catch(() => [])` told the panel the record was unsigned, and the panel said so
     * — "Nobody has signed this revision." — on an outage, to a reader with no way to tell the
     * difference. `null` is the panel's cue to say it could not read them instead.
     */
    expect(await signaturesProp('fails')).toBeNull();
  });
});
