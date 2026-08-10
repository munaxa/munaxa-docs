'use server';

import {
  type DocumentSignature,
  type SignatureStatementPreview,
  type SignatureVerification,
  previewSignatureStatementQuerySchema,
  signRevisionSchema,
  withdrawSignatureSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminRead, adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * Electronic signatures, from the browser's side — Phase 6.6.
 *
 * ## Why every one of these is a server action, including the reads
 *
 * The access token lives in an `httpOnly` cookie and never reaches client JavaScript
 * (`17-security-architecture.md` §2). There is no browser-side API client in this product and
 * adding one would mean handing the token to a script, so the ceremony reaches the API exactly the
 * way check-in and publish do.
 *
 * That is not merely consistency here — it is what makes §11.200 safe. The password and the TOTP
 * code are read out of a `<form>`'s `FormData` inside `signRevision` and forwarded to the API in
 * the same call. **They are never assigned to React state, never held between stages, never in a
 * URL, and never in a store.** The sign-in form uses the same shape for the same reason, and this
 * follows it rather than inventing a second way to collect a credential.
 *
 * ## What is deliberately absent
 *
 * No re-authentication action, because the API has no re-authentication endpoint —
 * `SignerAuthenticator` is an internal port and credentials are proved by the act that consumes
 * them. A standalone "check my password" call would be the credential oracle ADR-0017 §6's single
 * undifferentiated refusal exists to prevent, and building one would be inventing backend
 * capability. The ceremony's consequence is set out in `signing-ceremony.tsx`.
 *
 * No statement construction of any kind. `previewStatement` returns the server's bytes and the
 * screen renders them; nothing here composes, parses, translates or digests them.
 */

/** Every signature on a document, live and withdrawn. `document:view`. */
export async function fetchSignatures(
  documentId: string,
): Promise<ActionResult<readonly DocumentSignature[]>> {
  return adminRead<readonly DocumentSignature[]>(`/documents/${documentId}/signatures`);
}

/**
 * The statement this person would sign, if they signed now — Phase 6.6A's route.
 *
 * A read, and side-effect free: it creates no signature, writes no audit event and reserves
 * nothing. It refuses for every reason signing would refuse *before* writing — a discarded
 * revision, a signature this person already holds — so the ceremony never displays a statement for
 * an act the server is about to reject.
 */
export async function previewStatement(
  documentId: string,
  input: unknown,
): Promise<ActionResult<SignatureStatementPreview>> {
  return validated(previewSignatureStatementQuerySchema, input, (query) => {
    const search = new URLSearchParams({ revisionId: query.revisionId, purpose: query.purpose });
    if (query.statement !== undefined && query.statement !== '') {
      search.set('statement', query.statement);
    }
    return adminRead<SignatureStatementPreview>(
      `/documents/${documentId}/signatures/statement?${search.toString()}`,
    );
  });
}

/**
 * The signature itself — the one call that accepts credentials, and the only one.
 *
 * `signRevisionSchema` is the API's own schema, so the browser and the server agree about what a
 * signing request is by construction rather than by convention. The credentials pass through this
 * function and into the request body; nothing keeps a copy.
 */
export async function signRevision(
  documentId: string,
  input: unknown,
): Promise<ActionResult<DocumentSignature>> {
  return validated(signRevisionSchema, input, (body) =>
    adminWrite<DocumentSignature>({
      path: `/documents/${documentId}/signatures`,
      method: 'POST',
      body,
    }),
  );
}

/**
 * Verification — three booleans, never collapsed into one.
 *
 * `signatureValid` false means the row was altered or the key is gone. `contentMatches` false means
 * the signature is intact and is about content the revision no longer holds, which is a §11.70
 * finding rather than a broken signature. `withdrawn` is neither. The screen renders all three.
 *
 * No cryptography happens in the browser: the HMAC is recomputed by the server, which is the only
 * party holding the witness key.
 */
export async function verifySignature(
  documentId: string,
  signatureId: string,
): Promise<ActionResult<SignatureVerification>> {
  return adminRead<SignatureVerification>(
    `/documents/${documentId}/signatures/${signatureId}/verification`,
  );
}

/**
 * Taking a signature back.
 *
 * Never a delete: the row keeps its bytes and gains `withdrawn_at`, `withdrawn_by` and the stated
 * reason, and the trail records a second event rather than editing the first. The API refuses
 * anybody but the signer, which is why the screen offers this only on your own signature — the
 * button is a courtesy and the refusal is the control.
 */
export async function withdrawSignature(
  documentId: string,
  signatureId: string,
  input: unknown,
): Promise<ActionResult<DocumentSignature>> {
  return validated(withdrawSignatureSchema, input, (body) =>
    adminWrite<DocumentSignature>({
      path: `/documents/${documentId}/signatures/${signatureId}/withdrawal`,
      method: 'POST',
      body,
    }),
  );
}
