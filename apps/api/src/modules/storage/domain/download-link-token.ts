import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The capability a verified download link carries — ADR-0026 §10,
 * `docs/reports/hetzner-download-integrity-proposal.md` §3.1, and for the export kinds
 * `docs/reports/hetzner-export-verified-delivery-design.md` §2.
 *
 * The preview stream's construction, with its own purpose string so neither token is ever the
 * other, and neither is ever a session. A browser follows the link by navigation, which carries no
 * bearer token, so the token is the credential. It is deliberately *not* the authorization:
 *
 * - It names the person it was issued to and the permission version they held then. Redemption
 *   looks the person up again and refuses the link if the version moved — a sign-out everywhere, a
 *   disabled account, a password reset or a role change all move it.
 * - It names **what kind of thing** it was issued for and that thing's own identifiers — a
 *   document (and revision), a document released by a bulk export, a report export, one artefact
 *   of an audit export, a bulk export's manifest — so redemption re-asks *that* thing's questions
 *   through the module that owns it, rather than trusting the issue-time answer or inferring
 *   anything from the blob, which several exports may share.
 * - It names the blob, so a link for one file can never serve another.
 *
 * ## Kinds, and compatibility in both directions
 *
 * A token with no kind (`s`) is a `DOCUMENT` token: exactly the bytes issued before kinds existed,
 * so a link issued by the previous release still redeems. Every other kind **omits a key the
 * previous decoder requires** (`d` or `r`), so an instance running the previous release refuses it
 * as malformed instead of redeeming it as a document — a rolling deployment cannot misroute.
 *
 * Decoding is strict: each kind has an exact set of keys, identifiers must be UUIDs, and an unknown
 * kind, a missing key or an extra one is `MALFORMED`. Nothing is defaulted or guessed.
 *
 * Expiry is short (`DOWNLOAD_LINK_TTL_SECONDS`, 60 s) because the link is still a bearer link for
 * that long; the checks above are what keep a copied link from outliving the reason it was issued.
 */

/** The controller's path, relative to the API prefix. */
export const DOWNLOAD_LINK_PATH = 'downloads';

export const DownloadLinkKind = {
  /** A document's content, or one revision's. The only kind before export links existed. */
  DOCUMENT: 'DOCUMENT',
  /** A document released by a bulk export: every document rule, plus the export's own. */
  BULK_DOCUMENT: 'BULK_DOCUMENT',
  /** A report export's file. */
  REPORT_EXPORT: 'REPORT_EXPORT',
  /** One named artefact of an audit (evidence) export. */
  AUDIT_ARTEFACT: 'AUDIT_ARTEFACT',
  /** A bulk export's manifest. */
  BULK_MANIFEST: 'BULK_MANIFEST',
} as const;

export type DownloadLinkKindKey = (typeof DownloadLinkKind)[keyof typeof DownloadLinkKind];

export type DownloadLinkSubject =
  | {
      readonly kind: typeof DownloadLinkKind.DOCUMENT;
      readonly documentId: string;
      /** Null for "the document's current content"; a revision id for that revision's content. */
      readonly revisionId: string | null;
    }
  | {
      readonly kind: typeof DownloadLinkKind.BULK_DOCUMENT;
      readonly documentId: string;
      readonly operationId: string;
    }
  | { readonly kind: typeof DownloadLinkKind.REPORT_EXPORT; readonly exportId: string }
  | {
      readonly kind: typeof DownloadLinkKind.AUDIT_ARTEFACT;
      readonly exportId: string;
      readonly artefact: string;
    }
  | { readonly kind: typeof DownloadLinkKind.BULK_MANIFEST; readonly operationId: string };

export interface DownloadLinkGrant {
  readonly tenantId: string;
  readonly userId: string;
  readonly permissionVersion: number;
  readonly subject: DownloadLinkSubject;
  readonly fileObjectId: string;
  readonly disposition: 'inline' | 'attachment';
  readonly filename: string;
  /** The media type the issuer took from the object's own record — never from a shared blob. */
  readonly mimeType: string;
  readonly expiresAt: Date;
}

/** The grant narrowed to one kind — what a redeemer for that kind receives. */
export type DownloadLinkGrantOf<K extends DownloadLinkKindKey> = DownloadLinkGrant & {
  readonly subject: Extract<DownloadLinkSubject, { readonly kind: K }>;
};

export type DownloadLinkRejection = 'MALFORMED' | 'EXPIRED' | 'BAD_SIGNATURE';

const SEPARATOR = '.';
const PURPOSE = 'munaxa.download.link';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** An audit artefact's name: `events.jsonl`, `events.csv`, `manifest.json`, `manifest.sig`. */
const ARTEFACT = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

/** The keys every kind carries. */
const COMMON = ['t', 'u', 'v', 'f', 'k', 'n', 'm', 'e'] as const;

/** Exactly the subject keys each kind carries, beside the common ones and `s`. */
const SUBJECT_KEYS: Readonly<Record<DownloadLinkKindKey, readonly string[]>> = {
  // No `s`: the previous release's exact payload.
  DOCUMENT: ['d', 'r'],
  // No `r`: the previous decoder requires it, so it refuses this kind.
  BULK_DOCUMENT: ['d', 'o'],
  // No `d`: likewise.
  REPORT_EXPORT: ['x'],
  AUDIT_ARTEFACT: ['x', 'a'],
  BULK_MANIFEST: ['o'],
};

function subjectPayload(subject: DownloadLinkSubject): Record<string, unknown> {
  switch (subject.kind) {
    case DownloadLinkKind.DOCUMENT:
      return { d: subject.documentId, r: subject.revisionId };
    case DownloadLinkKind.BULK_DOCUMENT:
      return { s: subject.kind, d: subject.documentId, o: subject.operationId };
    case DownloadLinkKind.REPORT_EXPORT:
      return { s: subject.kind, x: subject.exportId };
    case DownloadLinkKind.AUDIT_ARTEFACT:
      return { s: subject.kind, x: subject.exportId, a: subject.artefact };
    case DownloadLinkKind.BULK_MANIFEST:
      return { s: subject.kind, o: subject.operationId };
  }
}

function payloadOf(grant: DownloadLinkGrant): string {
  const subject = subjectPayload(grant.subject);
  return JSON.stringify({
    t: grant.tenantId,
    u: grant.userId,
    v: grant.permissionVersion,
    // The document kind keeps its keys where they always were, so its payload is unchanged.
    ...(grant.subject.kind === DownloadLinkKind.DOCUMENT ? subject : {}),
    f: grant.fileObjectId,
    k: grant.disposition,
    n: grant.filename,
    m: grant.mimeType,
    e: grant.expiresAt.getTime(),
    ...(grant.subject.kind === DownloadLinkKind.DOCUMENT ? {} : subject),
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

function isKind(value: unknown): value is DownloadLinkKindKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(SUBJECT_KEYS, value);
}

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function grantOf(parsed: unknown): DownloadLinkGrant | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  // An absent kind is a document link; a present one must be one this release knows, and never
  // the document kind spelled out (that payload has never existed, so it was not issued here).
  const kind: unknown = 's' in raw ? raw['s'] : DownloadLinkKind.DOCUMENT;
  if (!isKind(kind) || ('s' in raw && kind === DownloadLinkKind.DOCUMENT)) {
    return null;
  }
  const allowed = new Set<string>([...COMMON, ...SUBJECT_KEYS[kind], ...('s' in raw ? ['s'] : [])]);
  const keys = Object.keys(raw);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
    return null;
  }
  if (
    !isUuid(raw['t']) ||
    !isUuid(raw['u']) ||
    typeof raw['v'] !== 'number' ||
    !Number.isInteger(raw['v']) ||
    !isUuid(raw['f']) ||
    (raw['k'] !== 'inline' && raw['k'] !== 'attachment') ||
    typeof raw['n'] !== 'string' ||
    typeof raw['m'] !== 'string' ||
    typeof raw['e'] !== 'number'
  ) {
    return null;
  }
  const subject = subjectOf(kind, raw);
  if (subject === null) {
    return null;
  }
  return {
    tenantId: raw['t'],
    userId: raw['u'],
    permissionVersion: raw['v'],
    subject,
    fileObjectId: raw['f'],
    disposition: raw['k'],
    filename: raw['n'],
    mimeType: raw['m'],
    expiresAt: new Date(raw['e']),
  };
}

function subjectOf(
  kind: DownloadLinkKindKey,
  raw: Record<string, unknown>,
): DownloadLinkSubject | null {
  switch (kind) {
    case DownloadLinkKind.DOCUMENT: {
      const revision = raw['r'];
      return isUuid(raw['d']) && (revision === null || isUuid(revision))
        ? { kind, documentId: raw['d'], revisionId: revision }
        : null;
    }
    case DownloadLinkKind.BULK_DOCUMENT:
      return isUuid(raw['d']) && isUuid(raw['o'])
        ? { kind, documentId: raw['d'], operationId: raw['o'] }
        : null;
    case DownloadLinkKind.REPORT_EXPORT:
      return isUuid(raw['x']) ? { kind, exportId: raw['x'] } : null;
    case DownloadLinkKind.AUDIT_ARTEFACT:
      return isUuid(raw['x']) && typeof raw['a'] === 'string' && ARTEFACT.test(raw['a'])
        ? { kind, exportId: raw['x'], artefact: raw['a'] }
        : null;
    case DownloadLinkKind.BULK_MANIFEST:
      return isUuid(raw['o']) ? { kind, operationId: raw['o'] } : null;
  }
}
