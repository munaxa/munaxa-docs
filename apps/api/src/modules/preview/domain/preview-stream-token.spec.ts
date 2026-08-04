import { describe, expect, it } from 'vitest';

import { decodePreviewToken, encodePreviewToken } from './preview-stream-token';
import { isMostlyEncodable, stampViewer, winAnsiSafe } from './watermark-text';

const SECRET = 'a-suite-secret-of-at-least-thirty-two-chars';
const NOW = new Date('2026-08-20T09:00:00.000Z');

const GRANT = {
  fileObjectId: '01890000-0000-7000-8000-000000000001',
  tenantId: '01890000-0000-7000-8000-0000000000aa',
  mimeType: 'application/pdf',
  disposition: 'inline' as const,
  expiresAt: new Date(NOW.getTime() + 300_000),
  watermark: { viewer: 'Dana Q', reference: 'DOC-001', issuedAt: '2026-08-20 09:00 UTC' },
};

describe('the preview stream token', () => {
  it('round-trips a grant, watermark included', () => {
    const token = encodePreviewToken(SECRET, GRANT);
    const decoded = decodePreviewToken(SECRET, token, NOW);
    expect('grant' in decoded && decoded.grant).toMatchObject({
      fileObjectId: GRANT.fileObjectId,
      tenantId: GRANT.tenantId,
      mimeType: 'application/pdf',
      disposition: 'inline',
      watermark: GRANT.watermark,
    });
  });

  it('refuses a tampered payload: the signature is over every field', () => {
    const token = encodePreviewToken(SECRET, GRANT);
    const [payload = '', signature = ''] = token.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    forged['f'] = '01890000-0000-7000-8000-00000000dead';
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
    expect(decodePreviewToken(SECRET, tampered, NOW)).toEqual({ rejection: 'BAD_SIGNATURE' });
  });

  it('refuses an expired grant and a foreign secret', () => {
    const token = encodePreviewToken(SECRET, GRANT);
    expect(decodePreviewToken(SECRET, token, new Date(NOW.getTime() + 301_000))).toEqual({
      rejection: 'EXPIRED',
    });
    expect(decodePreviewToken('another-secret-of-at-least-32-characters!', token, NOW)).toEqual({
      rejection: 'BAD_SIGNATURE',
    });
  });

  it('refuses garbage without throwing', () => {
    expect(decodePreviewToken(SECRET, '', NOW)).toEqual({ rejection: 'MALFORMED' });
    expect(decodePreviewToken(SECRET, 'not-a-token', NOW)).toEqual({ rejection: 'MALFORMED' });
  });
});

describe('the watermark text rules', () => {
  it('keeps a Latin name and substitutes an Arabic one with its fallback', () => {
    expect(stampViewer('Dana Q', 'dana@example.com')).toBe('Dana Q');
    expect(stampViewer('دانة القحطاني', 'dana@example.com')).toBe('dana@example.com');
  });

  it('never yields an empty stamp', () => {
    expect(winAnsiSafe('العربية')).toBe('?');
    expect(isMostlyEncodable('العربية')).toBe(false);
  });
});
