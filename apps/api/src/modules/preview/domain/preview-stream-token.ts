import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The capability a preview URL carries — the same construction, byte for byte in spirit, as
 * the `LOCAL` storage transfer token, and for the same reason: a preview URL is redeemed by an
 * `<img>` tag, a fetch from a viewer, or the browser's own print frame, none of which carry a
 * bearer token. The token *is* the credential, so it names exactly one artefact of one
 * revision, one disposition, one expiry — and, when the confidentiality level demands it, the
 * watermark that must be burned in before a byte leaves.
 *
 * Single-page by construction (14 §4): the grant names one artefact. There is no token that
 * lists a directory, so holding page three's URL says nothing about page four — a caller gets
 * each page's URL from the API, which re-checks permission, state and confidentiality each
 * time.
 *
 * Domain-separated from every other HMAC use of the deployment secret, so a preview token is
 * not a storage transfer token and neither is ever a session.
 */

/** The controller's path, relative to the API prefix. One definition, two readers. */
export const PREVIEW_STREAM_PATH = 'preview/stream';

export interface PreviewStreamGrant {
  /** The artefact's blob. The unscoped key: the tenant prefix is applied at redemption. */
  readonly fileObjectId: string;
  readonly tenantId: string;
  readonly mimeType: string;
  readonly disposition: 'inline' | 'attachment';
  readonly expiresAt: Date;
  /** Present when the level demands a mark; absent bytes are served as stored. */
  readonly watermark: {
    readonly viewer: string;
    readonly reference: string;
    readonly issuedAt: string;
  } | null;
}

export type PreviewStreamRejection = 'MALFORMED' | 'EXPIRED' | 'BAD_SIGNATURE';

const SEPARATOR = '.';

function payloadOf(grant: PreviewStreamGrant): string {
  return JSON.stringify({
    f: grant.fileObjectId,
    t: grant.tenantId,
    m: grant.mimeType,
    d: grant.disposition,
    e: grant.expiresAt.getTime(),
    w:
      grant.watermark === null
        ? null
        : { v: grant.watermark.viewer, r: grant.watermark.reference, i: grant.watermark.issuedAt },
  });
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret)
    .update(`munaxa.preview.stream\n${payload}`)
    .digest('base64url');
}

export function encodePreviewToken(secret: string, grant: PreviewStreamGrant): string {
  const payload = payloadOf(grant);
  return `${Buffer.from(payload, 'utf8').toString('base64url')}${SEPARATOR}${sign(secret, payload)}`;
}

export function decodePreviewToken(
  secret: string,
  token: string,
  now: Date,
): { readonly grant: PreviewStreamGrant } | { readonly rejection: PreviewStreamRejection } {
  const separator = token.lastIndexOf(SEPARATOR);
  if (separator <= 0) {
    return { rejection: 'MALFORMED' };
  }
  const encoded = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  let payload: string;
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return { rejection: 'MALFORMED' };
  }
  const expected = sign(secret, payload);
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return { rejection: 'BAD_SIGNATURE' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { rejection: 'MALFORMED' };
  }
  const grant = grantOf(parsed);
  if (grant === null) {
    return { rejection: 'MALFORMED' };
  }
  if (grant.expiresAt.getTime() <= now.getTime()) {
    return { rejection: 'EXPIRED' };
  }
  return { grant };
}

function grantOf(parsed: unknown): PreviewStreamGrant | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const watermark = raw['w'];
  if (
    typeof raw['f'] !== 'string' ||
    typeof raw['t'] !== 'string' ||
    typeof raw['m'] !== 'string' ||
    (raw['d'] !== 'inline' && raw['d'] !== 'attachment') ||
    typeof raw['e'] !== 'number'
  ) {
    return null;
  }
  let mark: PreviewStreamGrant['watermark'] = null;
  if (watermark !== null && watermark !== undefined) {
    if (typeof watermark !== 'object') {
      return null;
    }
    const markRaw = watermark as Record<string, unknown>;
    if (
      typeof markRaw['v'] !== 'string' ||
      typeof markRaw['r'] !== 'string' ||
      typeof markRaw['i'] !== 'string'
    ) {
      return null;
    }
    mark = { viewer: markRaw['v'], reference: markRaw['r'], issuedAt: markRaw['i'] };
  }
  return {
    fileObjectId: raw['f'],
    tenantId: raw['t'],
    mimeType: raw['m'],
    disposition: raw['d'],
    expiresAt: new Date(raw['e']),
    watermark: mark,
  };
}
