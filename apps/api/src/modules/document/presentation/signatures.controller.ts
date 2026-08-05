import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import {
  type DocumentSignature,
  type SignRevisionBody,
  type SignatureVerification,
  type WithdrawSignatureBody,
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
