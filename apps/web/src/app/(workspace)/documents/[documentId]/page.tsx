import { notFound } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';

import type {
  Document,
  DocumentSignature,
  DocumentWorkflow,
  PreviewManifest,
  RevisionHistory,
} from '@edms/contracts';
import { DomainError, ErrorCode, Permission } from '@edms/domain';

import { AdminForbidden, RateLimited } from '../../../../features/admin-shared';
import { ApprovalPanel } from '../../../../features/approvals/approval-panel';
import { AuditTimeline } from '../../../../features/audit/audit-timeline';
import { DocumentScreen } from '../../../../features/documents/document-screen';
import { PreviewPanel } from '../../../../features/preview/preview-panel';
import { RevisionPanel } from '../../../../features/revisions/revision-panel';
import { SignaturePanel } from '../../../../features/signatures/signature-panel';
import { adminAccess, adminGet } from '../../../../lib/admin/api';

/**
 * One document.
 *
 * Fetching it is what records the view: the API's `GET` writes the "recently opened" entry and the
 * audit event that confidentiality levels demanding audit-on-read require. That is why opening a
 * document is a page navigation rather than a panel that expands — a compliance record that
 * depended on a client remembering to call something would not be a compliance record.
 *
 * The approval area is fetched alongside, in the same round of requests. Phase 4 added it, and it is
 * on this page rather than a page of its own for one reason: "who must agree before this becomes
 * official, and where has it got to" is a question about *this document*, and answering it somewhere
 * else would make somebody navigate away from the thing they are deciding about.
 *
 * The audit timeline is the one panel deliberately *not* in that round of requests. Phase 9 added
 * it inside a `Suspense` boundary, fetching its own data, which is what `16 §7`'s "shell first,
 * preview and audit stream in" actually requires: awaited beside the document, a slow trail query
 * would delay the number, the title and every action on the page. Suspended, it delays nothing.
 *
 * ## What this page no longer fetches — Phase 7.1C
 *
 * Everything the *dialogues* need. The tenant's categories, confidentiality levels, users,
 * departments, metadata fields and document types filled the properties form; the candidate folders
 * filled the move picker. All seven were awaited on first paint, on every document anybody opened,
 * for two dialogues that are closed — and a reader who only wanted to read a controlled document
 * paid for a form they never saw. They are loaded now when the dialogue opens, through
 * `loadEditOptions` and `loadMoveOptions`. The endpoints, the token and the permissions behind them
 * are unchanged; only the moment changed.
 *
 * Phase 7.1B is why the moment mattered: fifteen API requests for one page view, measured against
 * a rate-limit bucket keyed by tenant and identity, and the record page was the page holding the
 * budget when it ran out.
 */
export default async function DocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}): Promise<ReactNode> {
  const { documentId } = await params;
  try {
    return await documentPage(documentId);
  } catch (error) {
    /**
     * The one API refusal this page can answer honestly rather than crash on.
     *
     * `429` is neither a fault nor a permission decision: the request was well formed, the caller is
     * who they say they are, and the same request succeeds again within the window. Rethrown, it
     * reaches the route error boundary, which can only say "Something went wrong. The problem has
     * been recorded" — untrue twice, and unactionable. Everything else still throws, because a page
     * that cannot load its document has nothing to render and the error boundary *is* the honest
     * answer for that.
     */
    if (error instanceof DomainError && error.code === ErrorCode.RATE_LIMITED) {
      return <RateLimited />;
    }
    throw error;
  }
}

async function documentPage(documentId: string): Promise<ReactNode> {
  const access = await adminAccess(Permission.DOCUMENT_VIEW);
  if (!access.granted) {
    return <AdminForbidden />;
  }

  let document: Document;
  try {
    document = await adminGet<Document>(`/documents/${documentId}`);
  } catch (error) {
    if (error instanceof DomainError && error.code === ErrorCode.NOT_FOUND) {
      notFound();
    }
    throw error;
  }

  // The timeline is compliance evidence with its own permission: fetched only when the caller
  // holds `document:history:view`, and the panel simply omits it otherwise.
  const canViewHistory = access.permissions.includes(Permission.DOCUMENT_HISTORY_VIEW);

  const [workflow, history, preview, signatures, mfa] = await Promise.all([
    adminGet<DocumentWorkflow>(`/documents/${documentId}/workflow`),
    canViewHistory
      ? adminGet<RevisionHistory>(`/documents/${documentId}/revisions`)
      : Promise.resolve(null),
    // The viewer's manifest. Absent — a document with no content yet, or an API refusal — the
    // panel is simply not rendered, which is the same posture as the history above.
    adminGet<PreviewManifest>(`/documents/${documentId}/preview`).catch(() => null),
    // Signatures are part of the record and are read with `document:view`, like the timeline
    // above. A refusal or an outage leaves the panel with an empty list rather than taking the
    // whole page down — the same posture the preview manifest takes.
    adminGet<readonly DocumentSignature[]>(`/documents/${documentId}/signatures`).catch(() => []),
    // Whether *this* caller owes a second factor when they sign. Their own status and nobody
    // else's: there is no request in this product by which one person could ask about another's,
    // which is what keeps the ceremony from becoming an enrolment oracle.
    adminGet<{ readonly enrolled: boolean }>('/auth/mfa').catch(() => ({ enrolled: false })),
  ]);

  return (
    <DocumentScreen
      document={document}
      canEdit={access.permissions.includes(Permission.DOCUMENT_EDIT)}
      canMove={access.permissions.includes(Permission.DOCUMENT_MOVE)}
      canDownload={access.permissions.includes(Permission.DOCUMENT_DOWNLOAD)}
      canAssignNumber={access.permissions.includes(Permission.NUMBERING_MANAGE)}
      canManagePermissions={access.permissions.includes(Permission.DOCUMENT_PERMISSION_MANAGE)}
      canArchive={access.permissions.includes(Permission.DOCUMENT_ARCHIVE)}
      preview={
        preview === null ? undefined : (
          <PreviewPanel
            document={document}
            initialManifest={preview}
            canPrint={access.permissions.includes(Permission.DOCUMENT_PRINT)}
            canDownload={access.permissions.includes(Permission.DOCUMENT_DOWNLOAD)}
          />
        )
      }
      approvals={
        <ApprovalPanel
          workflow={workflow}
          canSubmit={access.permissions.includes(Permission.DOCUMENT_SUBMIT)}
          canApprove={access.permissions.includes(Permission.DOCUMENT_APPROVE)}
          canReject={access.permissions.includes(Permission.DOCUMENT_REJECT)}
          canManage={access.permissions.includes(Permission.WORKFLOW_MANAGE)}
        />
      }
      signatures={
        <SignaturePanel
          document={document}
          signatures={signatures}
          canSign={access.permissions.includes(Permission.DOCUMENT_SIGN)}
          mfaEnrolled={mfa.enrolled}
        />
      }
      audit={
        <Suspense fallback={null}>
          <AuditTimeline subjectType="DOCUMENT" subjectId={documentId} />
        </Suspense>
      }
      revisions={
        <RevisionPanel
          document={document}
          history={history}
          availableTransitions={workflow.availableTransitions}
          canCheckout={access.permissions.includes(Permission.DOCUMENT_CHECKOUT)}
          canCheckin={access.permissions.includes(Permission.DOCUMENT_CHECKIN)}
          canForce={access.permissions.includes(Permission.DOCUMENT_FORCE_CHECKIN)}
          canPublish={access.permissions.includes(Permission.DOCUMENT_PUBLISH)}
          canDownload={access.permissions.includes(Permission.DOCUMENT_DOWNLOAD)}
        />
      }
    />
  );
}
