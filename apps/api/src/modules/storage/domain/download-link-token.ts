import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The capability a verified download link carries — ADR-0026 §10,
 * `docs/reports/hetzner-download-integrity-proposal.md` §3.1.
 *
 * The preview stream's construction, with its own purpose string so neither token is ever the
 * other, and neither is ever a session. A browser follows the link by navigation, which carries no
 * bearer token, so the token is the credential. It is deliberately *not* the authorization:
 *
 * - It names the person it was issued to and the permission version they held then. Redemption
 *   looks the person up again and refuses the link if the version moved — a sign-out everywhere, a
 *   disabled account, a password reset or a role change all move it.
 * - It names the document (and revision) it was issued for, so redemption re-asks the document's
 *   own questions — ACL, confidentiality level, which revision is current — rather than trusting
 *   the issue-time answer.
 * - It names the blob, so a link for one file can never serve another.
 *
 * Expiry is short (`DOWNLOAD_LINK_TTL_SECONDS`) because the link is still a bearer link for that
 * long; the checks above are what keep a copied link from outliving the reason it was issued.
 */

/** The controller's path, relative to the API prefix. */
export const DOWNLOAD_LINK_PATH = 'downloads';

export interface DownloadLinkGrant {
  readonly tenantId: string;
  readonly userId: string;
  readonly permissionVersion: number;
  readonly documentId: string;
  /** Null for "the document's current content"; a revision id for that revision's content. */
  readonly revisionId: string | null;
  readonly fileObjectId: string;
  readonly disposition: 'inline' | 'attachment';
  readonly filename: string;
  readonly mimeType: string;
  readonly expiresAt: Date;
}

export type DownloadLinkRejection = 'MALFORMED' | 'EXPIRED' | 'BAD_SIGNATURE';

const SEPARATOR = '.';
const PURPOSE = 'munaxa.download.link';

function payloadOf(grant: DownloadLinkGrant): string {
  return JSON.stringify({
    t: grant.tenantId,
    u: grant.userId,
    v: grant.permissionVersion,
    d: grant.documentId,
    r: grant.revisionId,
    f: grant.fileObjectId,
    k: grant.disposition,
    n: grant.filename,
    m: grant.mimeType,
    e: grant.expiresAt.getTime(),
  });
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`${PURPOSE}\n${payload}`).digest('base64url');
}

export function encodeDownloadLinkToken(secret: string, grant: DownloadLinkGrant): string {
  const payload = payloadOf(grant);
  return `${Buffer.from(payload, 'utf8').toString('base64url')}${SEPARATOR}${sign(secret, payload)}`;
}

export function decodeDownloadLinkToken(
  secret: string,
  token: string,
  now: Date,
): { readonly grant: DownloadLinkGrant } | { readonly rejection: DownloadLinkRejection } {
  const separator = token.lastIndexOf(SEPARATOR);
  if (separator <= 0) {
    return { rejection: 'MALFORMED' };
  }
  const payload = Buffer.from(token.slice(0, separator), 'base64url').toString('utf8');
  // Verified before anything in the payload is read, and before the expiry is checked.
  const given = Buffer.from(token.slice(separator + 1), 'utf8');
  const wanted = Buffer.from(sign(secret, payload), 'utf8');
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

function grantOf(parsed: unknown): DownloadLinkGrant | null {
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const revision = raw['r'];
  if (
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
  ) {
    return null;
  }
  return {
    tenantId: raw['t'],
    userId: raw['u'],
    permissionVersion: raw['v'],
    documentId: raw['d'],
    revisionId: revision,
    fileObjectId: raw['f'],
    disposition: raw['k'],
    filename: raw['n'],
    mimeType: raw['m'],
    expiresAt: new Date(raw['e']),
  };
}
