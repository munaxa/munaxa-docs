import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type DownloadLinkGrant,
  decodeDownloadLinkToken,
  encodeDownloadLinkToken,
} from './download-link-token';

const SECRET = 'a-download-link-test-secret-of-32-chars';
const NOW = new Date('2026-10-14T12:00:00Z');
const GRANT: DownloadLinkGrant = {
  tenantId: '0199f5a1-5a9e-7000-8000-00000000a001',
  userId: '0199f5a1-5a9e-7000-8000-00000000b001',
  permissionVersion: 7,
  documentId: '0199f5a1-5a9e-7000-8000-00000000d001',
  revisionId: null,
  fileObjectId: '0199f5a1-5a9e-7000-8000-00000000f001',
  disposition: 'attachment',
  filename: 'تقرير.pdf',
  mimeType: 'application/pdf',
  expiresAt: new Date(NOW.getTime() + 60_000),
};

describe('the verified download link token', () => {
  it('round-trips every field, a non-ASCII name included', () => {
    const decoded = decodeDownloadLinkToken(SECRET, encodeDownloadLinkToken(SECRET, GRANT), NOW);
    expect(decoded).toEqual({ grant: GRANT });
    const revision = { ...GRANT, revisionId: '0199f5a1-5a9e-7000-8000-00000000e001' };
    expect(decodeDownloadLinkToken(SECRET, encodeDownloadLinkToken(SECRET, revision), NOW)).toEqual(
      { grant: revision },
    );
  });

  it('refuses an expired link', () => {
    const token = encodeDownloadLinkToken(SECRET, GRANT);
    expect(decodeDownloadLinkToken(SECRET, token, GRANT.expiresAt)).toEqual({
      rejection: 'EXPIRED',
    });
  });

  it('refuses a link whose payload or signature was edited, before reading the payload', () => {
    const token = encodeDownloadLinkToken(SECRET, GRANT);
    const [payload, signature] = token.split('.') as [string, string];
    const other = Buffer.from(
      Buffer.from(payload, 'base64url').toString('utf8').replace('f001', 'f002'),
      'utf8',
    ).toString('base64url');
    expect(decodeDownloadLinkToken(SECRET, `${other}.${signature}`, NOW)).toEqual({
      rejection: 'BAD_SIGNATURE',
    });
    expect(decodeDownloadLinkToken(SECRET, `${payload}.${signature.slice(1)}x`, NOW)).toEqual({
      rejection: 'BAD_SIGNATURE',
    });
    expect(decodeDownloadLinkToken('another-secret-of-thirty-two-chars!', token, NOW)).toEqual({
      rejection: 'BAD_SIGNATURE',
    });
  });

  it('refuses garbage', () => {
    expect(decodeDownloadLinkToken(SECRET, '', NOW)).toEqual({ rejection: 'MALFORMED' });
    expect(decodeDownloadLinkToken(SECRET, 'no-separator', NOW)).toEqual({
      rejection: 'MALFORMED',
    });
  });

  it('does not accept the same payload signed for another purpose (a preview token)', () => {
    const payload = Buffer.from(
      encodeDownloadLinkToken(SECRET, GRANT).split('.')[0] ?? '',
      'base64url',
    ).toString('utf8');
    const previewSigned = createHmac('sha256', SECRET)
      .update(`munaxa.preview.stream\n${payload}`)
      .digest('base64url');
    const forged = `${Buffer.from(payload, 'utf8').toString('base64url')}.${previewSigned}`;
    expect(decodeDownloadLinkToken(SECRET, forged, NOW)).toEqual({ rejection: 'BAD_SIGNATURE' });
  });
});
