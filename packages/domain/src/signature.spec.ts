import { describe, expect, it } from 'vitest';

import {
  SIGNATURE_STATEMENT_VERSION,
  SignaturePurpose,
  type SignatureStatement,
  isSignaturePurpose,
  revisionIsSignable,
  serialiseSignatureStatement,
} from './signature';

const STATEMENT: SignatureStatement = {
  tenantId: '019489f0-0000-7000-8000-0000000000a1',
  documentId: '019489f0-0000-7000-8000-0000000000d1',
  documentNumber: 'QMS-SOP-0001',
  revisionId: '019489f0-0000-7000-8000-0000000000r1',
  revisionLabel: 'Rev 2',
  contentDigest: 'a'.repeat(64),
  signerUserId: '019489f0-0000-7000-8000-0000000000u1',
  signerName: 'Ada Lovelace',
  signerEmail: 'ada@example.test',
  purpose: SignaturePurpose.APPROVAL,
  statement: 'Fit for release.',
  signedAt: '2026-08-06T09:00:00.000Z',
};

describe('serialiseSignatureStatement', () => {
  it('is byte-stable and carries its own version', () => {
    const body = serialiseSignatureStatement(STATEMENT);

    expect(body.startsWith(`munaxa-docs-signature/v${String(SIGNATURE_STATEMENT_VERSION)}\n`)).toBe(
      true,
    );
    expect(body).toBe(serialiseSignatureStatement({ ...STATEMENT }));
    expect(body.endsWith('\n')).toBe(true);
  });

  // §11.70's signature/record linking: the digest is *in* the signed bytes, so a row repointed at
  // other content no longer verifies. Changing only the digest must change the signed body.
  it('binds the content digest, so repointing the row breaks verification', () => {
    const other = serialiseSignatureStatement({ ...STATEMENT, contentDigest: 'b'.repeat(64) });
    expect(other).not.toBe(serialiseSignatureStatement(STATEMENT));
  });

  // The tenant is in the bytes because a digest is not unique across tenants: without it, a
  // signature copied from one tenant's database into another's would verify against the same key.
  it('binds the tenant', () => {
    const other = serialiseSignatureStatement({ ...STATEMENT, tenantId: 'other-tenant' });
    expect(other).not.toBe(serialiseSignatureStatement(STATEMENT));
  });

  // §11.50 requires the printed name and the meaning. A signature that recorded neither would be
  // indistinguishable from any other person's signature for any other reason.
  it('carries the printed name and the meaning', () => {
    const body = serialiseSignatureStatement(STATEMENT);
    expect(body).toContain('signer-name:Ada Lovelace');
    expect(body).toContain('purpose:APPROVAL');
  });

  it('records an unnumbered draft honestly rather than leaving the field out', () => {
    const body = serialiseSignatureStatement({ ...STATEMENT, documentNumber: null });
    expect(body).toContain('\nnumber:\n');
    expect(body.split('\n')).toHaveLength(
      serialiseSignatureStatement(STATEMENT).split('\n').length,
    );
  });

  // A newline in a display name is the one character that could forge a field boundary — a name of
  // "Ada\npurpose:WITNESS" must not be able to say it was a witness signature.
  it('cannot be made to forge a field boundary through a display name', () => {
    const body = serialiseSignatureStatement({
      ...STATEMENT,
      signerName: 'Ada\npurpose:WITNESS',
    });
    expect(body).toContain('signer-name:Ada purpose:WITNESS');
    expect(body.split('\n').filter((line) => line.startsWith('purpose:'))).toHaveLength(1);
  });
});

describe('isSignaturePurpose', () => {
  it('narrows a stored value to the catalogue', () => {
    expect(isSignaturePurpose('WITNESS')).toBe(true);
    expect(isSignaturePurpose('RUBBER_STAMP')).toBe(false);
  });
});

describe('revisionIsSignable', () => {
  // A draft is signable — authorship is routinely signed before review, and `purpose` says which
  // act it was. What is not signable is content somebody deliberately threw away.
  it('allows a draft and refuses a discarded revision', () => {
    expect(revisionIsSignable('DRAFT')).toBe(true);
    expect(revisionIsSignable('PUBLISHED')).toBe(true);
    expect(revisionIsSignable('DISCARDED')).toBe(false);
  });
});
