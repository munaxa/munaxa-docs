import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, written out rather than pulled in.
 *
 * The decision is worth stating, because "use the SDK" is the usual answer. What this adapter
 * needs from S3 is five operations — presign a PUT, presign a GET, HEAD, copy, delete — and the
 * v3 SDK's client plus its presigner is roughly forty megabytes of dependency, a middleware stack
 * and a credential-provider chain that will happily read an instance metadata endpoint the product
 * never intended to talk to. Signing is a hash chain and a canonical string; it is about a hundred
 * lines, it is specified precisely, and AWS publishes test vectors for it — which is what
 * `sigv4.spec.ts` asserts against. A dependency whose behaviour cannot be pinned to a published
 * vector is a dependency that has to be trusted rather than checked.
 *
 * It is also what makes MinIO, Cloudflare R2 and AWS one adapter instead of three: they differ in
 * endpoint and addressing style, not in how a request is signed.
 *
 * Nothing here knows what a document is. It signs HTTP requests.
 */

export interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Present for temporary credentials, absent for a static key pair. */
  readonly sessionToken?: string | undefined;
}

export interface CanonicalRequest {
  readonly method: string;
  /** Already percent-encoded, path segments only, always starting with `/`. */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string;
}

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_PAYLOAD_HASH = createHash('sha256').update('').digest('hex');

const ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * RFC 3986 percent-encoding, which is not what `encodeURIComponent` does.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped. S3 escapes them, so a key containing an
 * apostrophe — `O'Brien contract.pdf` is an ordinary filename — would be signed one way and
 * requested another, and the request would fail its own signature check. The difference is four
 * characters and it is the classic hand-rolled-SigV4 defect.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A storage key as a URL path: each segment encoded, the separators left alone. */
export function encodePath(key: string): string {
  return `/${key.split('/').map(uriEncode).join('/')}`;
}

/** `20260804T101530Z` and `20260804`, which are the two forms every part of this needs. */
export function amzDate(at: Date): { readonly long: string; readonly short: string } {
  const long = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { long, short: long.slice(0, 8) };
}

export function canonicalQueryString(query: Readonly<Record<string, string>>): string {
  // Sorted by the *encoded* name, which is what the specification says and what differs from
  // sorting by the raw one the moment a parameter name contains a character that encodes upward.
  return Object.entries(query)
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

interface CanonicalHeaders {
  readonly canonical: string;
  readonly signed: string;
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): CanonicalHeaders {
  const normalised = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase().trim(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    canonical: normalised.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: normalised.map(([name]) => name).join(';'),
  };
}

export function canonicalize(request: CanonicalRequest): {
  readonly text: string;
  readonly signedHeaders: string;
} {
  const { canonical, signed } = canonicalHeaders(request.headers);
  return {
    text: [
      request.method,
      request.path,
      canonicalQueryString(request.query),
      canonical,
      signed,
      request.payloadHash,
    ].join('\n'),
    signedHeaders: signed,
  };
}

export function credentialScope(short: string, region: string, service: string): string {
  return `${short}/${region}/${service}/aws4_request`;
}

export function stringToSign(
  at: Date,
  region: string,
  service: string,
  canonicalRequest: string,
): string {
  const { long, short } = amzDate(at);
  return [
    ALGORITHM,
    long,
    credentialScope(short, region, service),
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
}

/**
 * The derived signing key.
 *
 * Four chained HMACs, each keyed by the previous one, so a key is scoped to one day, one region
 * and one service. That scoping is the reason a leaked signature is not a leaked credential — and
 * the reason this cannot be shortened to "HMAC the string with the secret".
 */
export function signingKey(
  secretAccessKey: string,
  short: string,
  region: string,
  service: string,
): Buffer {
  const date = createHmac('sha256', `AWS4${secretAccessKey}`).update(short).digest();
  const regional = createHmac('sha256', date).update(region).digest();
  const serviced = createHmac('sha256', regional).update(service).digest();
  return createHmac('sha256', serviced).update('aws4_request').digest();
}

export interface SignedRequestInput {
  readonly credentials: SigningCredentials;
  readonly region: string;
  readonly service: string;
  readonly at: Date;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}

/**
 * Signs a request with an `Authorization` header — for the calls the API makes itself.
 *
 * HEAD, DELETE, the copy and the multipart completion all go out from the API rather than from a
 * browser, so they carry a header rather than a query signature. The distinction matters: a header
 * signature is not visible in a URL and therefore not in a log, a proxy's history or a referrer.
 */
export function signRequest(input: SignedRequestInput): Readonly<Record<string, string>> {
  const { long, short } = amzDate(input.at);
  const headers: Record<string, string> = {
    ...input.headers,
    host: input.host,
    'x-amz-date': long,
    'x-amz-content-sha256': input.payloadHash,
  };
  if (input.credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = input.credentials.sessionToken;
  }

  const { text, signedHeaders } = canonicalize({
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    headers,
    payloadHash: input.payloadHash,
  });
  const signature = createHmac(
    'sha256',
    signingKey(input.credentials.secretAccessKey, short, input.region, input.service),
  )
    .update(stringToSign(input.at, input.region, input.service, text))
    .digest('hex');

  const scope = credentialScope(short, input.region, input.service);
  return {
    ...headers,
    authorization:
      `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface PresignInput extends Omit<SignedRequestInput, 'payloadHash'> {
  readonly expiresInSeconds: number;
  /**
   * Headers the *client* must send for the signature to verify.
   *
   * `host` is always one of them, and for an upload `content-type` and `content-length` are too:
   * signing them is what binds the presigned URL to the size and type the policy approved, so a
   * target issued for a 40 kB PDF cannot be used to store a 2 GB anything
   * (`11-storage-architecture.md` §4).
   */
  readonly signedHeaders?: Readonly<Record<string, string>>;
}

/**
 * The query string of a presigned URL: the signature travels as parameters, so a browser can use
 * the URL directly with no header it would have to be told to send.
 *
 * Returns the query string rather than a whole URL, because the caller owns the endpoint and the
 * addressing style — path or virtual-host — and building a URL here would mean this file knowing
 * which of them a provider wants.
 *
 * The payload is deliberately unsigned. Signing it would mean the API had to hash bytes it never
 * sees — which is the whole point of presigning — so integrity is established afterwards, by
 * reading the object's own digest back at completion rather than by trusting the upload.
 */
export function presignedQueryString(input: PresignInput): string {
  const { long, short } = amzDate(input.at);
  const headers: Record<string, string> = { ...input.signedHeaders, host: input.host };
  const { signed } = canonicalHeaders(headers);

  const query: Record<string, string> = {
    ...input.query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${credentialScope(short, input.region, input.service)}`,
    'X-Amz-Date': long,
    'X-Amz-Expires': String(input.expiresInSeconds),
    'X-Amz-SignedHeaders': signed,
  };
  if (input.credentials.sessionToken !== undefined) {
    query['X-Amz-Security-Token'] = input.credentials.sessionToken;
  }

  const { text } = canonicalize({
    method: input.method,
    path: input.path,
    query,
    headers,
    payloadHash: UNSIGNED_PAYLOAD,
  });
  const signature = createHmac(
    'sha256',
    signingKey(input.credentials.secretAccessKey, short, input.region, input.service),
  )
    .update(stringToSign(input.at, input.region, input.service, text))
    .digest('hex');

  return `${canonicalQueryString(query)}&X-Amz-Signature=${signature}`;
}
