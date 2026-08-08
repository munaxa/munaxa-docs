import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import {
  type DocumentSignature,
  type PreviewSignatureStatementQuery,
  type SignRevisionBody,
  type SignatureStatementPreview,
  type SignatureVerification,
  type WithdrawSignatureBody,
  previewSignatureStatementQuerySchema,
  signRevisionSchema,
  withdrawSignatureSchema,
} from '@edms/contracts';
import { Permission, ScopeType } from '@edms/domain';

import { RequirePermission, ScopedTo } from '../../../core/authorization/permission.decorator';
import { ZodValidationPipe } from '../../../core/http/zod-validation.pipe';
import type { SignatureRecord } from '../application/signature.ports';
import { DocumentSignatureService } from '../application/signature.service';

/**
 * Electronic signatures on a document's revisions.
 *
 * Every route here is `@ScopedTo` the **document**, because that is the object reach is decided at
 * and because these are single-object routes — the contrast with the bulk controller beside them is
 * deliberate and is the whole reason that one has to resolve reach itself.
 *
 * Signing is `document:sign`, which
 * [ADR-0017](../../../../../docs/architecture/adr/0017-electronic-signature-as-witnessed-attestation.md)
 * §5 seeds to no role including the tenant administrator: it is an `S`, granted by an ACL entry on
 * the node somebody is accountable for. Reading and verifying are `document:view` — a signature is
 * part of the record, and somebody who may read a controlled document may see who put their name to
 * it. A withdrawal is `document:sign` again *and* the service refuses anybody but the signer, which
 * is two gates for one act because the permission says "you may sign here" and the second says
 * "this one is yours".
 *
 * The statement preview added by Phase 6.6A is `document:sign` rather than `document:view`, and
 * that is the one judgement on this controller worth stating twice: it discloses nothing a reader
 * cannot already see, and it is guarded as the first step of a ceremony rather than as a way of
 * reading. Its own comment argues the case.
 */
@Controller({ path: 'documents/:id/signatures', version: '1' })
export class DocumentSignaturesController {
  constructor(private readonly signatures: DocumentSignatureService) {}

  @Get()
  @RequirePermission(Permission.DOCUMENT_VIEW)
  @ScopedTo('id', ScopeType.DOCUMENT)
  async list(@Param('id') id: string): Promise<readonly DocumentSignature[]> {
    return (await this.signatures.listForDocument(id)).map(toSignature);
  }

  /**
   * The statement, before it is signed — Phase 6.6A, and the route Phase 6.6 stopped for.
   *
   * `document:sign` rather than `document:view`, which is the whole security decision here. The
   * statement itself discloses nothing a reader cannot already see — the document's number, the
   * revision's label, the content digest, the caller's *own* name and address — so the permission
   * is not protecting a secret. It is saying what the surface is *for*: this is the first step of
   * a §11.50 ceremony, and it belongs to the people who may complete one. Widening it to
   * `document:view` would make the preview a capability of its own, reachable by callers with no
   * business assembling an attestation.
   *
   * Declared above the `:signatureId` routes so a reader sees why there is no ambiguity: those
   * match two segments, this matches one, and `statement` is not a signature identifier.
   *
   * It asks for no credentials. §11.200 re-authentication belongs to the `POST` below.
   */
  @Get('statement')
  @RequirePermission(Permission.DOCUMENT_SIGN)
  @ScopedTo('id', ScopeType.DOCUMENT)
  async statement(
    @Param('id') id: string,
    @Query(new ZodValidationPipe(previewSignatureStatementQuerySchema))
    query: PreviewSignatureStatementQuery,
  ): Promise<SignatureStatementPreview> {
    const preview = await this.signatures.previewStatement({
      documentId: id,
      revisionId: query.revisionId,
      purpose: query.purpose,
      statement: query.statement ?? null,
    });
    return {
      revisionId: preview.revisionId,
      purpose: preview.purpose,
      statementBody: preview.statementBody,
      preparedAt: preview.preparedAt.toISOString(),
    };
  }

  @Post()
  @RequirePermission(Permission.DOCUMENT_SIGN)
  @ScopedTo('id', ScopeType.DOCUMENT)
  async sign(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(signRevisionSchema)) body: SignRevisionBody,
  ): Promise<DocumentSignature> {
    return toSignature(
      await this.signatures.sign({
        documentId: id,
        revisionId: body.revisionId,
        purpose: body.purpose,
        statement: body.statement ?? null,
        password: body.password ?? null,
        mfaCode: body.mfaCode ?? null,
      }),
    );
  }

  /**
   * Verification.
   *
   * A `GET`, because it changes nothing — and it deliberately answers three booleans rather than
   * one. `signatureValid` false means the row was altered or the key is gone; `contentMatches`
   * false means the signature is intact and is about content this revision no longer holds, which
   * is a §11.70 finding rather than a broken signature; `withdrawn` is neither.
   */
  @Get(':signatureId/verification')
  @RequirePermission(Permission.DOCUMENT_VIEW)
  @ScopedTo('id', ScopeType.DOCUMENT)
  async verify(
    @Param('id') _id: string,
    @Param('signatureId') signatureId: string,
  ): Promise<SignatureVerification> {
    const outcome = await this.signatures.verify(signatureId);
    return {
      signatureId: outcome.signature.id,
      signatureValid: outcome.signatureValid,
      contentMatches: outcome.contentMatches,
      withdrawn: outcome.withdrawn,
      witnessedBy: outcome.witnessedBy,
      algorithm: outcome.signature.algorithm,
      statementBody: outcome.signature.statementBody,
    };
  }

  @Post(':signatureId/withdrawal')
  @RequirePermission(Permission.DOCUMENT_SIGN)
  @ScopedTo('id', ScopeType.DOCUMENT)
  async withdraw(
    @Param('id') _id: string,
    @Param('signatureId') signatureId: string,
    @Body(new ZodValidationPipe(withdrawSignatureSchema)) body: WithdrawSignatureBody,
  ): Promise<DocumentSignature> {
    return toSignature(await this.signatures.withdraw(signatureId, body.reason));
  }
}

function toSignature(record: SignatureRecord): DocumentSignature {
  return {
    id: record.id,
    documentId: record.documentId,
    revisionId: record.revisionId,
    revisionLabel: record.revisionLabel,
    signerUserId: record.signerUserId,
    signerName: record.signerName,
    purpose: record.purpose,
    statement: record.statement,
    signedAt: record.signedAt.toISOString(),
    reauthenticated: record.reauthenticated,
    withdrawnAt: record.withdrawnAt?.toISOString() ?? null,
    withdrawnReason: record.withdrawnReason,
  };
}
