import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  type DownloadLinkGrant,
  type DownloadLinkSubject,
  decodeDownloadLinkToken,
  encodeDownloadLinkToken,
} from './download-link-token';

const SECRET = 'a-download-link-test-secret-of-32-chars';
const NOW = new Date('2026-10-14T12:00:00Z');
const GRANT: DownloadLinkGrant = {
  tenantId: '0199f5a1-5a9e-7000-8000-00000000a001',
  userId: '0199f5a1-5a9e-7000-8000-00000000b001',
  permissionVersion: 7,
  subject: {
    kind: 'DOCUMENT',
    documentId: '0199f5a1-5a9e-7000-8000-00000000d001',
    revisionId: null,
  },
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
    const revision: DownloadLinkGrant = {
      ...GRANT,
      subject: {
        kind: 'DOCUMENT',
        documentId: '0199f5a1-5a9e-7000-8000-00000000d001',
        revisionId: '0199f5a1-5a9e-7000-8000-00000000e001',
      },
    };
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

const OPERATION = '0199f5a1-5a9e-7000-8000-00000000c0a1';
const EXPORT = '0199f5a1-5a9e-7000-8000-00000000c0e1';

const KINDS: readonly [string, DownloadLinkSubject][] = [
  [
    'BULK_DOCUMENT',
    { kind: 'BULK_DOCUMENT', documentId: GRANT_DOCUMENT(), operationId: OPERATION },
  ],
  ['REPORT_EXPORT', { kind: 'REPORT_EXPORT', exportId: EXPORT }],
  ['AUDIT_ARTEFACT', { kind: 'AUDIT_ARTEFACT', exportId: EXPORT, artefact: 'events.jsonl' }],
  ['BULK_MANIFEST', { kind: 'BULK_MANIFEST', operationId: OPERATION }],
];

function GRANT_DOCUMENT(): string {
  return '0199f5a1-5a9e-7000-8000-00000000d001';
}

/** Re-signs an edited payload with the real secret: what only the issuer could produce. */
function signed(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  const signature = createHmac('sha256', SECRET)
    .update(`munaxa.download.link\n${text}`)
    .digest('base64url');
  return `${Buffer.from(text, 'utf8').toString('base64url')}.${signature}`;
}

function payloadOf(grant: DownloadLinkGrant): Record<string, unknown> {
  const token = encodeDownloadLinkToken(SECRET, grant);
  return JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

/** The previous release's `grantOf` checks, verbatim: what an instance not yet upgraded runs. */
function previousDecoderAccepts(raw: Record<string, unknown>): boolean {
  const revision = raw['r'];
  return !(
    typeof raw['t'] !== 'string' ||
    typeof raw['u'] !== 'string' ||
    typeof raw['v'] !== 'number' ||
    typeof raw['d'] !== 'string' ||
    (revision !== null && typeof revision !== 'string') ||
    typeof raw['f'] !== 'string' ||
    (raw['k'] !== 'inline' && raw['k'] !== 'attachment') ||
    typeof raw['n'] !== 'string' ||
    typeof raw['m'] !== 'string' ||
    typeof raw['e'] !== 'number'
  );
}

describe('the link kinds', () => {
  it.each(KINDS)('round-trips a %s link', (_kind, subject) => {
    const grant: DownloadLinkGrant = { ...GRANT, subject, mimeType: 'text/csv; charset=utf-8' };
    expect(decodeDownloadLinkToken(SECRET, encodeDownloadLinkToken(SECRET, grant), NOW)).toEqual({
      grant,
    });
  });

  it('keeps a document link byte for byte what the previous release issued, so its links still redeem', () => {
    const previous = {
      t: GRANT.tenantId,
      u: GRANT.userId,
      v: GRANT.permissionVersion,
      d: '0199f5a1-5a9e-7000-8000-00000000d001',
      r: null,
      f: GRANT.fileObjectId,
      k: GRANT.disposition,
      n: GRANT.filename,
      m: GRANT.mimeType,
      e: GRANT.expiresAt.getTime(),
    };
    expect(encodeDownloadLinkToken(SECRET, GRANT)).toBe(signed(previous));
    expect(decodeDownloadLinkToken(SECRET, signed(previous), NOW)).toEqual({ grant: GRANT });
  });

  it.each(KINDS)(
    'issues a %s link the previous release refuses rather than redeeming as a document',
    (_kind, subject) => {
      expect(previousDecoderAccepts(payloadOf({ ...GRANT, subject }))).toBe(false);
    },
  );

  it('refuses a kind this release does not know, and the document kind spelled out', () => {
    const base = payloadOf(GRANT);
    expect(decodeDownloadLinkToken(SECRET, signed({ ...base, s: 'SOMETHING_NEW' }), NOW)).toEqual({
      rejection: 'MALFORMED',
    });
    expect(decodeDownloadLinkToken(SECRET, signed({ ...base, s: 'DOCUMENT' }), NOW)).toEqual({
      rejection: 'MALFORMED',
    });
    expect(decodeDownloadLinkToken(SECRET, signed({ ...base, s: 42 }), NOW)).toEqual({
      rejection: 'MALFORMED',
    });
  });

  it('refuses a key another kind carries — an export link cannot also name a document', () => {
    const report = payloadOf({ ...GRANT, subject: { kind: 'REPORT_EXPORT', exportId: EXPORT } });
    for (const extra of [
      { d: GRANT_DOCUMENT() },
      { o: OPERATION },
      { a: 'events.jsonl' },
      { r: null },
      { anything: 1 },
    ]) {
      expect(decodeDownloadLinkToken(SECRET, signed({ ...report, ...extra }), NOW)).toEqual({
        rejection: 'MALFORMED',
      });
    }
  });

  it('refuses a link missing one of its kind’s keys', () => {
    const audit = payloadOf({
      ...GRANT,
      subject: { kind: 'AUDIT_ARTEFACT', exportId: EXPORT, artefact: 'events.csv' },
    });
    for (const key of ['x', 'a', 't', 'u', 'v', 'f', 'k', 'n', 'm', 'e']) {
      const { [key]: _removed, ...rest } = audit;
      expect(decodeDownloadLinkToken(SECRET, signed(rest), NOW), key).toEqual({
        rejection: 'MALFORMED',
      });
    }
  });

  it('refuses identifiers that are not identifiers, and artefact names that are not names', () => {
    const report = payloadOf({ ...GRANT, subject: { kind: 'REPORT_EXPORT', exportId: EXPORT } });
    for (const edit of [
      { x: '../../other' },
      { x: 'ABC' },
      { t: 'acme' },
      { f: '' },
      { u: 7 },
      { v: 1.5 },
    ]) {
      expect(decodeDownloadLinkToken(SECRET, signed({ ...report, ...edit }), NOW)).toEqual({
        rejection: 'MALFORMED',
      });
    }
    const audit = payloadOf({
      ...GRANT,
      subject: { kind: 'AUDIT_ARTEFACT', exportId: EXPORT, artefact: 'events.csv' },
    });
    for (const artefact of ['../manifest.json', '', 'A'.repeat(65), 'events csv']) {
      expect(decodeDownloadLinkToken(SECRET, signed({ ...audit, a: artefact }), NOW)).toEqual({
        rejection: 'MALFORMED',
      });
    }
  });

  it('expires every kind on the same clock', () => {
    for (const [, subject] of KINDS) {
      const token = encodeDownloadLinkToken(SECRET, { ...GRANT, subject });
      expect(decodeDownloadLinkToken(SECRET, token, GRANT.expiresAt)).toEqual({
        rejection: 'EXPIRED',
      });
    }
  });
});
