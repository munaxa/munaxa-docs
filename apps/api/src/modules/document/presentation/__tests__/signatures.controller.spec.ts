import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { previewSignatureStatementQuerySchema } from '@edms/contracts';
import { ALL_SIGNATURE_PURPOSES, Permission, ScopeType } from '@edms/domain';

import {
  PERMISSION_SCOPE,
  REQUIRED_PERMISSIONS,
  type ScopeBinding,
} from '../../../../core/authorization/permission.decorator';
import { ruleForRequest } from '../../../../core/security/rate-limit';
import { DocumentSignaturesController } from '../signatures.controller';

/**
 * What each signature route is guarded by, read off the route itself — Phase 6.6A.
 *
 * The guards are proven to *run* by the HTTP suite; what only reflection can state cheaply, on
 * every push, is which permission each route declares. That matters here because Phase 6.6A adds
 * a route whose authorization is a judgement rather than a default: the statement preview is
 * behind `document:sign` and not `document:view`, even though every value in the statement is
 * already visible to a reader.
 *
 * The reasoning is worth keeping beside the assertion. The preview is not protected because the
 * text is a secret — it is the document's number, the revision's label, the content digest and the
 * caller's own name. It is behind `document:sign` because of what it is *for*: the first step of a
 * §11.50 ceremony, which belongs to the people who may complete one. A caller who may read a
 * controlled document has no business assembling an attestation over it, and a route that let them
 * would be a capability nobody granted.
 *
 * `document:view` on the list and on verification is the other half of the same judgement, and is
 * asserted here so a future change to either is a change to this file.
 */

interface RouteGuard {
  readonly permissions: readonly string[];
  readonly scope: ScopeBinding | undefined;
}

function guardOf(method: keyof DocumentSignaturesController): RouteGuard {
  const handler = DocumentSignaturesController.prototype[method] as unknown as object;
  return {
    permissions: (Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) ?? []) as readonly string[],
    scope: Reflect.getMetadata(PERMISSION_SCOPE, handler) as ScopeBinding | undefined,
  };
}

const DOCUMENT_SCOPE: ScopeBinding = { param: 'id', scopeType: ScopeType.DOCUMENT };

describe('the signature routes declare what they are guarded by', () => {
  it('puts the statement preview behind document:sign, not document:view', () => {
    expect(guardOf('statement').permissions).toEqual([Permission.DOCUMENT_SIGN]);
  });

  it('scopes the statement preview to the document in the path', () => {
    // The same binding every other route on this controller carries. A preview that resolved
    // reach differently from the act it precedes would be a second answer to one question.
    expect(guardOf('statement').scope).toEqual(DOCUMENT_SCOPE);
  });

  it('leaves the existing routes exactly as they were', () => {
    expect(guardOf('list').permissions).toEqual([Permission.DOCUMENT_VIEW]);
    expect(guardOf('verify').permissions).toEqual([Permission.DOCUMENT_VIEW]);
    expect(guardOf('sign').permissions).toEqual([Permission.DOCUMENT_SIGN]);
    expect(guardOf('withdraw').permissions).toEqual([Permission.DOCUMENT_SIGN]);

    for (const route of ['list', 'verify', 'sign', 'withdraw'] as const) {
      expect(guardOf(route).scope, route).toEqual(DOCUMENT_SCOPE);
    }
  });
});

describe('what the preview query accepts', () => {
  const revisionId = '019489f0-0000-7000-8000-0000000000c3';

  it('accepts every purpose in the existing catalogue and no others', () => {
    // The same enum signing uses, not a second list. §11.50 makes meaning part of the
    // manifestation, so `purpose` is a closed vocabulary — a tenant needing a sixth changes the
    // catalogue in `@edms/domain`, and this fails on the day somebody adds one without deciding
    // whether it may be previewed.
    for (const purpose of ALL_SIGNATURE_PURPOSES) {
      expect(
        previewSignatureStatementQuerySchema.safeParse({ revisionId, purpose }).success,
        purpose,
      ).toBe(true);
    }
    expect(
      previewSignatureStatementQuerySchema.safeParse({ revisionId, purpose: 'RUBBER_STAMP' })
        .success,
    ).toBe(false);
  });

  it('refuses a revision identifier that is not one', () => {
    expect(
      previewSignatureStatementQuerySchema.safeParse({ revisionId: 'latest', purpose: 'APPROVAL' })
        .success,
    ).toBe(false);
  });

  it('carries no credential field, and discards one that is offered', () => {
    // The one difference from `signRevisionSchema`, and the reason the route is a `GET`: §11.200
    // re-authentication belongs to the act, and a query string is the last place a password should
    // be. A client that sent one anyway gets it dropped at the pipe — `z.object` strips what it
    // does not declare — so nothing downstream can read it, log it or key a cache on it.
    const offered = previewSignatureStatementQuerySchema.safeParse({
      revisionId,
      purpose: 'APPROVAL',
      password: 'correct horse battery staple',
      mfaCode: '123456',
    });
    expect(offered.success).toBe(true);
    expect(offered.success && Object.keys(offered.data).sort()).toEqual(['purpose', 'revisionId']);
    expect(Object.keys(previewSignatureStatementQuerySchema.shape).sort()).toEqual([
      'purpose',
      'revisionId',
      'statement',
    ]);
  });
});

describe('the preview is not a signing attempt', () => {
  const documentId = '019489f0-0000-7000-8000-0000000000a1';

  it('does not fall under document.sign', () => {
    // Phase 6.7's `document.sign` bounds an *act* that accepts credentials — five in fifteen
    // minutes, tight because the refusal it protects is deliberately undifferentiated. A read that
    // asks for no credentials must not spend that budget, or a signer who re-reads the statement
    // twice locks themselves out of signing it.
    expect(ruleForRequest('GET', `/api/v1/documents/${documentId}/signatures/statement`).rule).toBe(
      'default',
    );
  });

  it('leaves the signing route classified exactly as Phase 6.7 left it', () => {
    // No rule was added and none was widened by this phase. The preview inherits `default`,
    // which is the existing architecture applying rather than a new limiter appearing.
    const signing = ruleForRequest('POST', `/api/v1/documents/${documentId}/signatures`);
    expect(signing.rule).toBe('document.sign');
    expect(signing.credentialSensitive).toBe(true);
  });
});
