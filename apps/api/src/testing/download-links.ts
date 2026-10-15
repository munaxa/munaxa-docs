import {
  type DownloadLinkGrant,
  decodeDownloadLinkToken,
  encodeDownloadLinkToken,
} from '../modules/storage/domain/download-link-token';

/**
 * The grant an issued verified download link carries, read back with the secret that signed it —
 * what the redemption door decodes before it asks anything. Throws when the link is not a genuine,
 * unexpired one, so a suite never redeems something the door would have refused at the token.
 */
export function grantOfLink(url: string, secret: string, now: Date): DownloadLinkGrant {
  const parsed = new URL(url);
  if (!parsed.pathname.endsWith('/api/v1/downloads')) {
    throw new Error(`Not a verified download link: ${parsed.pathname}`);
  }
  const decoded = decodeDownloadLinkToken(secret, parsed.searchParams.get('token') ?? '', now);
  if ('rejection' in decoded) {
    throw new Error(`The link's token was refused: ${decoded.rejection}`);
  }
  return decoded.grant;
}

/**
 * A link's token, signed with the real secret, for a grant a suite composed itself — standing for a
 * link the issuer *could* have produced, to show what redemption does with one it should refuse.
 */
export function tokenFor(secret: string, grant: DownloadLinkGrant): string {
  return encodeDownloadLinkToken(secret, grant);
}
