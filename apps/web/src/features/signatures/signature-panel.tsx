'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Alert, Badge, Button, Card, useToast } from '@munaxa/ui';

import type { Document, DocumentSignature, SignatureVerification } from '@edms/contracts';

import { useSession, useTranslate } from '../../app/providers';
import { FormDialog, TextAreaField, text } from '../admin-shared';
import { fetchSignatures, verifySignature, withdrawSignature } from './actions';
import { SigningCeremony } from './signing-ceremony';

/**
 * Who has put their name to this document, and what that is worth — Phase 6.6.
 *
 * ## The states are the backend's two, and only those
 *
 * A signature here is **live** or **withdrawn**. There is no pending, requested, expired, awaiting,
 * delegated, sequential or quorum state, because the domain has none: a signature in this product is
 * *taken*, never requested, and inventing a request lifecycle in the browser would be inventing a
 * workflow with no server behind it. The list is exactly what `GET /documents/:id/signatures`
 * returns, withdrawn rows included — they are history, and a list that hid them would be a list
 * that quietly rewrote the record.
 *
 * ## Where the signed state comes from
 *
 * From the API, always. `onSigned` refetches and also calls `router.refresh()`, so what the screen
 * shows after signing is a fresh read rather than an optimistic guess — which is why a reload shows
 * the same thing. The ceremony's own success message is about the request it made; the list beneath
 * it is about what the database holds.
 *
 * ## What the buttons mean, and what they do not
 *
 * `canSign` hides the Sign action from somebody without `document:sign`. That is a courtesy and
 * nothing more: the route re-checks the permission and the ACL scope, and the statement preview is
 * behind the same pair. Withdrawal is offered only on your own signature for the same reason — the
 * service refuses anybody but the signer regardless, and the button merely avoids offering an act
 * that would be refused.
 */
export function SignaturePanel({
  document,
  signatures: initial,
  canSign,
  mfaEnrolled,
}: {
  readonly document: Document;
  readonly signatures: readonly DocumentSignature[];
  /** `document:sign` — ADR-0017 §5's `S`, seeded to no role and granted by an ACL entry. */
  readonly canSign: boolean;
  /** This caller's own factor status, from `GET /auth/mfa`. Never anybody else's. */
  readonly mfaEnrolled: boolean;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const toast = useToast();
  const session = useSession();

  const [signatures, setSignatures] = useState<readonly DocumentSignature[]>(initial);
  const [signing, setSigning] = useState(false);
  const [withdrawing, setWithdrawing] = useState<DocumentSignature | null>(null);

  // The latest revision, published or not — the one a signature would be about. Null on a
  // document with no content yet, which is when the Sign action is simply not offered.
  const revision = document.latestRevision;

  const reload = (): void => {
    void fetchSignatures(document.id).then((result) => {
      if (result.ok) {
        setSignatures(result.value);
      }
    });
    // The rest of the page reads the document too — the audit timeline most of all — so the
    // refresh is not redundant with the refetch above: one updates this list now, the other makes
    // the server components agree with it.
    router.refresh();
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-medium">{translate('signatures.title')}</h2>
        {canSign && revision !== null && (
          <Button
            type="button"
            onClick={() => {
              setSigning(true);
            }}
          >
            {translate('signatures.open')}
          </Button>
        )}
      </div>

      {signatures.length === 0 ? (
        <p className="mt-3 text-sm opacity-70">{translate('signatures.empty')}</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-3">
          {signatures.map((signature) => (
            <SignatureEntry
              key={signature.id}
              document={document}
              signature={signature}
              canWithdraw={canSign && signature.signerUserId === session.userId}
              onWithdraw={() => {
                setWithdrawing(signature);
              }}
            />
          ))}
        </ol>
      )}

      {signing && revision !== null && (
        <SigningCeremony
          documentId={document.id}
          documentTitle={document.title}
          revisionId={revision.id}
          revisionLabel={revision.label}
          mfaEnrolled={mfaEnrolled}
          onClose={() => {
            setSigning(false);
          }}
          onSigned={reload}
        />
      )}

      {withdrawing !== null && (
        <FormDialog
          open
          title={translate('signatures.withdraw.title')}
          description={translate('signatures.withdraw.description')}
          submitLabel={translate('signatures.withdraw.submit')}
          onClose={() => {
            setWithdrawing(null);
          }}
          onSubmit={(data) =>
            withdrawSignature(document.id, withdrawing.id, { reason: text(data, 'reason') })
          }
          onSaved={() => {
            setWithdrawing(null);
            toast.success(translate('signatures.withdrawn'));
            reload();
          }}
        >
          <TextAreaField name="reason" label={translate('signatures.withdraw.reason')} required />
        </FormDialog>
      )}
    </Card>
  );
}

/**
 * One signature, and — on request — what verifying it says.
 *
 * Verification is not run for every row on render. It re-reads the blob's digest and recomputes an
 * HMAC per signature, so a timeline that verified everything it happened to display would turn
 * opening a document into a batch job. It is an act somebody asks for, which is also how the API
 * treats it.
 */
function SignatureEntry({
  document,
  signature,
  canWithdraw,
  onWithdraw,
}: {
  readonly document: Document;
  readonly signature: DocumentSignature;
  readonly canWithdraw: boolean;
  readonly onWithdraw: () => void;
}): ReactNode {
  const translate = useTranslate();
  const [verification, setVerification] = useState<SignatureVerification | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);

  const verify = (): void => {
    setChecking(true);
    setFailed(false);
    void verifySignature(document.id, signature.id).then((result) => {
      setChecking(false);
      if (result.ok) {
        setVerification(result.value);
        return;
      }
      setFailed(true);
    });
  };

  return (
    <li className="border-s-2 ps-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          {translate('signatures.signedBy', {
            name: signature.signerName,
            purpose: translate(`signatures.purpose.${signature.purpose}`),
          })}
        </span>
        {signature.withdrawnAt !== null && (
          // `muted`, not `danger`. A withdrawn signature is *history* rather than a failure — the
          // same reading the revision timeline gives `SUPERSEDED` — and colouring it as an alarm
          // would tell a reader that something went wrong when somebody exercised an ordinary
          // right. It also avoids a platform palette defect the visual suite measured while this
          // was being written: `Badge tone="danger"` renders `text-destructive` on its own
          // `bg-destructive/15` tint at **3.41:1**, below the 4.5:1 WCAG 2.1 AA requires. That is
          // reported as a platform issue in the phase report rather than worked around here.
          <Badge tone="muted">{translate('signatures.withdrawn')}</Badge>
        )}
      </div>

      <p className="mt-1 text-sm opacity-70">
        {new Date(signature.signedAt).toLocaleString()} · {translate('revisions.title')}{' '}
        {signature.revisionLabel}
      </p>
      {signature.statement !== null && <p className="mt-1 text-sm">{signature.statement}</p>}
      {signature.withdrawnReason !== null && (
        <p className="mt-1 text-sm opacity-70">{signature.withdrawnReason}</p>
      )}

      <div className="mt-1 flex flex-wrap gap-2">
        <Button type="button" variant="ghost" disabled={checking} onClick={verify}>
          {checking
            ? translate('signatures.verify.checking')
            : translate('signatures.verify.action')}
        </Button>
        {canWithdraw && signature.withdrawnAt === null && (
          <Button type="button" variant="ghost" onClick={onWithdraw}>
            {translate('signatures.withdraw.action')}
          </Button>
        )}
      </div>

      {failed && (
        <Alert tone="warning" className="mt-2">
          {translate('signatures.verify.failed')}
        </Alert>
      )}

      {verification !== null && <VerificationResult verification={verification} />}
    </li>
  );
}

/**
 * The three booleans, each said on its own line.
 *
 * Collapsing them into one word is the mistake the contract's own comment warns about: a signature
 * whose bytes were altered and a signature its signer withdrew are completely different findings,
 * and `contentMatches` false is a §11.70 record-linking finding about a signature that is perfectly
 * intact. A single green tick would make an inspection unanswerable.
 *
 * `witnessedBy` names a key, never a certificate subject, because ADR-0017 refuses to imply a trust
 * framework this product is not party to.
 */
function VerificationResult({
  verification,
}: {
  readonly verification: SignatureVerification;
}): ReactNode {
  const translate = useTranslate();

  return (
    <div className="mt-2 flex flex-col gap-1 rounded border p-3 text-sm" role="status">
      <p className="font-medium">{translate('signatures.verify.title')}</p>
      <p>
        {verification.signatureValid
          ? translate('signatures.verify.valid')
          : translate('signatures.verify.invalid')}
      </p>
      <p>
        {verification.contentMatches
          ? translate('signatures.verify.contentIntact')
          : translate('signatures.verify.contentChanged')}
      </p>
      <p>
        {verification.withdrawn
          ? translate('signatures.verify.withdrawn')
          : translate('signatures.verify.standing')}
      </p>
      <p className="opacity-70">
        {translate('signatures.verify.witnessedBy', { witness: verification.witnessedBy })} ·{' '}
        {translate('signatures.verify.algorithm', { algorithm: verification.algorithm })}
      </p>
      <details className="mt-1">
        <summary className="cursor-pointer">{translate('signatures.verify.statement')}</summary>
        {/* The stored bytes, rendered verbatim — the same posture the ceremony takes, for the
            same reason: these are the bytes the witness was computed over. */}
        <pre
          className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border p-3 font-mono text-xs"
          dir="ltr"
        >
          {verification.statementBody}
        </pre>
      </details>
    </div>
  );
}
