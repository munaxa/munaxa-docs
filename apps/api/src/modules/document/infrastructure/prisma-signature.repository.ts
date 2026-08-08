import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  type AnyId,
  type DocumentId,
  type RevisionId,
  type SignaturePurposeKey,
  type UserId,
  asId,
} from '@edms/domain';

import { requireTransaction } from '../../../core/prisma/unit-of-work';
import { requireContext } from '../../../core/tenancy/tenant-context';
import type {
  DocumentSignatureRepository,
  NewSignature,
  SignatureRecord,
} from '../application/signature.ports';

/**
 * Signatures, in the database.
 *
 * **There is no `update` here beyond the withdrawal, and no `delete` at all.** A signature's
 * content columns are written once and never rewritten, which is the closest a table without a
 * database trigger gets to the audit trail's immutability — and the reason is the same: a
 * signature that could be edited would be a signature whose verification proves only that it
 * verifies *now*.
 *
 * The withdrawal writes three columns that were null and stays out of the rest. `withdraw` carries
 * `withdrawn_at IS NULL` in its predicate and answers whether it matched, so two people racing to
 * withdraw one signature produce one withdrawal and one refusal decided by the database rather
 * than by whichever read ran first.
 */
@Injectable()
export class PrismaDocumentSignatureRepository implements DocumentSignatureRepository {
  /**
   * Writes the signature, and translates the one violation that is a *business* outcome — 6.7.
   *
   * `uq_document_signature_live` is the partial unique index this table's comment has described
   * since Phase 16 and which nothing created until Phase 6.7. It is what actually stops two
   * concurrent requests minting two live attestations of the same fact: the service's
   * `liveSignatureExists` check is a read-then-write, and `TenantDatabase.withTenant` opens its
   * transaction with no `isolationLevel`, so under READ COMMITTED both callers can pass the check.
   *
   * The loser of that race must receive the same answer as somebody who simply signed twice in a
   * row — which the service already produces — rather than a raw constraint error or a `500`. So
   * `P2002` is translated here, at the boundary that knows what the index means, and every other
   * failure is rethrown untouched. This is the pattern `prisma-document-lock.repository.ts`
   * established for the live-lock index.
   */
  async insert(signature: NewSignature): Promise<void> {
    try {
      await this.write(signature);
    } catch (error) {
      if (isLiveSignatureViolation(error)) {
        throw new DuplicateSignatureError();
      }
      throw error;
    }
  }

  private async write(signature: NewSignature): Promise<void> {
    await requireTransaction().documentSignature.create({
      data: {
        id: signature.id,
        tenantId: this.tenantId(),
        documentId: signature.documentId,
        revisionId: signature.revisionId,
        signerUserId: signature.signerUserId,
        purpose: signature.purpose,
        statement: signature.statement,
        contentSha256: signature.contentSha256,
        statementBody: signature.statementBody,
        signature: signature.signature,
        algorithm: signature.algorithm,
        keyId: signature.keyId,
        signedAt: signature.signedAt,
        reauthenticated: signature.reauthenticated,
        createdBy: requireContext().userId,
      },
    });
  }

  async findById(id: string): Promise<SignatureRecord | null> {
    const row = await requireTransaction().documentSignature.findFirst({
      where: { id, tenantId: this.tenantId() },
      include: SIGNATURE_INCLUDE,
    });
    return row === null ? null : toRecord(row);
  }

  async listForRevision(revisionId: RevisionId): Promise<readonly SignatureRecord[]> {
    const rows = await requireTransaction().documentSignature.findMany({
      where: { revisionId, tenantId: this.tenantId() },
      include: SIGNATURE_INCLUDE,
      orderBy: { signedAt: 'desc' },
    });
    return rows.map(toRecord);
  }

  async listForDocument(documentId: DocumentId): Promise<readonly SignatureRecord[]> {
    const rows = await requireTransaction().documentSignature.findMany({
      where: { documentId, tenantId: this.tenantId() },
      include: SIGNATURE_INCLUDE,
      orderBy: { signedAt: 'desc' },
    });
    return rows.map(toRecord);
  }

  async liveSignatureExists(input: {
    readonly revisionId: string;
    readonly signerUserId: string;
    readonly purpose: SignaturePurposeKey;
  }): Promise<boolean> {
    const found = await requireTransaction().documentSignature.findFirst({
      where: {
        tenantId: this.tenantId(),
        revisionId: input.revisionId,
        signerUserId: input.signerUserId,
        purpose: input.purpose,
        withdrawnAt: null,
      },
      select: { id: true },
    });
    return found !== null;
  }

  async withdraw(input: {
    readonly id: string;
    readonly by: string;
    readonly reason: string;
    readonly at: Date;
  }): Promise<boolean> {
    // `withdrawn_at: null` is in the WHERE, so a second withdrawal matches nothing whatever the
    // caller read a moment earlier — the same shape as `assignNumber`'s write-once path.
    const { count } = await requireTransaction().documentSignature.updateMany({
      where: { id: input.id, tenantId: this.tenantId(), withdrawnAt: null },
      data: { withdrawnAt: input.at, withdrawnBy: input.by, withdrawnReason: input.reason },
    });
    return count > 0;
  }

  private tenantId(): string {
    return requireContext().tenantId;
  }
}

/**
 * The revision's label, joined.
 *
 * A signature stores the label *in its signed statement*, which is the authoritative copy. This
 * join is for the screen, and the two are the same value: a revision label never changes once
 * issued (`10-revision-architecture.md`).
 */
const SIGNATURE_INCLUDE = { revision: { select: { label: true } } } as const;

interface SignatureRow {
  id: string;
  documentId: string;
  revisionId: string;
  signerUserId: string;
  purpose: string;
  statement: string | null;
  contentSha256: string;
  statementBody: string;
  signature: string;
  algorithm: string;
  keyId: string;
  signedAt: Date;
  reauthenticated: boolean;
  withdrawnAt: Date | null;
  withdrawnBy: string | null;
  withdrawnReason: string | null;
  revision: { label: string };
}

function toRecord(row: SignatureRow): SignatureRecord {
  return {
    id: asId<AnyId>(row.id),
    documentId: asId<DocumentId>(row.documentId),
    revisionId: asId<RevisionId>(row.revisionId),
    revisionLabel: row.revision.label,
    signerUserId: asId<UserId>(row.signerUserId),
    // From the signed statement, never from the user row — §11.50's printed name is a fact about
    // the signature rather than about the person as they are today.
    signerName: printedNameOf(row.statementBody) ?? row.signerUserId,
    purpose: row.purpose as SignaturePurposeKey,
    statement: row.statement,
    contentSha256: row.contentSha256,
    statementBody: row.statementBody,
    signature: row.signature,
    algorithm: row.algorithm,
    keyId: row.keyId,
    signedAt: row.signedAt,
    reauthenticated: row.reauthenticated,
    withdrawnAt: row.withdrawnAt,
    withdrawnBy: row.withdrawnBy,
    withdrawnReason: row.withdrawnReason,
  };
}

/**
 * The printed name, read back out of the bytes that were signed.
 *
 * A read of the serialisation rather than a second column, deliberately: two copies of the same
 * fact drift, and the copy that matters is the signed one. The format is fixed by
 * `serialiseSignatureStatement` and versioned by its first line — an unrecognised body answers
 * null and the caller falls back to the identifier rather than displaying somebody else's name.
 */
function printedNameOf(statementBody: string): string | null {
  for (const line of statementBody.split('\n')) {
    if (line.startsWith('signer-name:')) {
      return line.slice('signer-name:'.length);
    }
  }
  return null;
}

/**
 * The loser of a signing race, named.
 *
 * A distinct class rather than a bare `ValidationError` so `DocumentSignatureService` can answer it
 * with the message it already uses for a sequential duplicate — one outcome for one situation,
 * whichever layer noticed it — without this file importing the service's wording.
 */
export class DuplicateSignatureError extends Error {
  constructor() {
    super('A live signature already exists for this signer, revision and purpose.');
    this.name = 'DuplicateSignatureError';
  }
}

/** The one violation `insert` translates; anything else is a genuine failure. */
function isLiveSignatureViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    // Named, so an unrelated unique index on this table in a later phase is not silently reported
    // as "you already signed this".
    JSON.stringify(error.meta ?? {}).includes('uq_document_signature_live')
  );
}
