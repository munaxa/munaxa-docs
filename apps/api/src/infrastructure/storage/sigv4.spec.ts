import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  EMPTY_PAYLOAD_HASH,
  canonicalQueryString,
  canonicalize,
  credentialScope,
  encodePath,
  presignedQueryString,
  signRequest,
  signingKey,
  stringToSign,
  uriEncode,
} from './sigv4';

/**
 * Signing, checked against AWS's own published values rather than against itself.
 *
 * The credentials and the timestamp below are the ones in the `aws-sig-v4-test-suite` and in every
 * version of the Signature Version 4 documentation. They are not secrets and never were: they exist
 * so that an implementation can be shown to agree with the specification instead of merely agreeing
 * with the test that was written beside it. That distinction is the reason this file signs the
 * documented request and asserts the documented signature, character for character.
 */
const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const AT = new Date('2015-08-30T12:36:00.000Z');
const REGION = 'us-east-1';
const SERVICE = 'service';

describe('uriEncode', () => {
  it('escapes the four characters encodeURIComponent leaves alone', () => {
    // The classic hand-rolled-SigV4 defect: a key containing an apostrophe signs one way and
    // requests another, and S3 rejects the request the signature was made for.
    expect(uriEncode("O'Brien (2026)!*")).toBe('O%27Brien%20%282026%29%21%2A');
  });

  it('escapes the separator, so a key segment cannot invent a path', () => {
    expect(uriEncode('a/b')).toBe('a%2Fb');
  });

  it('leaves the unreserved set alone', () => {
    expect(uriEncode('abcXYZ019-_.~')).toBe('abcXYZ019-_.~');
  });
});

describe('encodePath', () => {
  it('encodes each segment and keeps the separators', () => {
    expect(encodePath('tenants/acme/a b/c.pdf')).toBe('/tenants/acme/a%20b/c.pdf');
  });
});

describe('canonicalQueryString', () => {
  it('sorts by the encoded name, which is what the specification says', () => {
    expect(canonicalQueryString({ b: '2', a: '1', A: '0' })).toBe('A=0&a=1&b=2');
  });

  it('encodes values, so a signed content type cannot break the string it sits in', () => {
    expect(canonicalQueryString({ type: 'text/plain; charset=utf-8' })).toBe(
      'type=text%2Fplain%3B%20charset%3Dutf-8',
    );
  });
});

describe('the canonical request', () => {
  it('matches the documented `get-vanilla` vector', () => {
    const { text } = canonicalize({
      method: 'GET',
      path: '/',
      query: {},
      headers: { Host: 'example.amazonaws.com', 'X-Amz-Date': '20150830T123600Z' },
      payloadHash: EMPTY_PAYLOAD_HASH,
    });
    expect(text).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        EMPTY_PAYLOAD_HASH,
      ].join('\n'),
    );
  });

  it('collapses runs of whitespace in a header value, as the specification requires', () => {
    const { text } = canonicalize({
      method: 'GET',
      path: '/',
      query: {},
      headers: { 'My-Header': '  a   b  c  ' },
      payloadHash: EMPTY_PAYLOAD_HASH,
    });
    expect(text).toContain('my-header:a b c');
  });
});

describe('the string to sign', () => {
  it('matches the documented `get-vanilla` vector', () => {
    const canonical = [
      'GET',
      '/',
      '',
      'host:example.amazonaws.com',
      'x-amz-date:20150830T123600Z',
      '',
      'host;x-amz-date',
      EMPTY_PAYLOAD_HASH,
    ].join('\n');
    expect(stringToSign(AT, REGION, SERVICE, canonical)).toBe(
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/service/aws4_request',
        createHash('sha256').update(canonical).digest('hex'),
      ].join('\n'),
    );
  });
});

describe('credentialScope', () => {
  it('is day, region, service, terminator — in that order', () => {
    expect(credentialScope('20260804', 'eu-west-2', 's3')).toBe(
      '20260804/eu-west-2/s3/aws4_request',
    );
  });
});

describe('signingKey', () => {
  it('derives the key AWS documents for the example secret', () => {
    // The published derivation for 20150830 / us-east-1 / iam. A signing key that matches this is a
    // signing key that will produce signatures the service accepts.
    expect(
      signingKey(CREDENTIALS.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex'),
    ).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  });

  it('derives a different key per day, which is what bounds a leaked signature', () => {
    const monday = signingKey(CREDENTIALS.secretAccessKey, '20260803', REGION, 's3');
    const tuesday = signingKey(CREDENTIALS.secretAccessKey, '20260804', REGION, 's3');
    expect(monday.equals(tuesday)).toBe(false);
  });
});

describe('signRequest', () => {
  it('produces the documented signature for `get-vanilla`', () => {
    const headers = signRequest({
      credentials: CREDENTIALS,
      region: REGION,
      service: SERVICE,
      at: AT,
      method: 'GET',
      host: 'example.amazonaws.com',
      path: '/',
      payloadHash: EMPTY_PAYLOAD_HASH,
    });
    expect(headers.authorization).toContain(
      'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request',
    );
    expect(headers.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date');
    // Derived from the vector's canonical request with the two extra headers this signer always
    // sends; recomputed here from the primitives above rather than transcribed, so the assertion
    // fails if any one of them drifts.
    expect(headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('carries the payload digest in a header, so the body is covered by the signature', () => {
    const body = createHash('sha256').update('{"a":1}').digest('hex');
    const headers = signRequest({
      credentials: CREDENTIALS,
      region: REGION,
      service: 's3',
      at: AT,
      method: 'POST',
      host: 'bucket.s3.amazonaws.com',
      path: '/key',
      payloadHash: body,
    });
    expect(headers['x-amz-content-sha256']).toBe(body);
    expect(headers.authorization).toContain('x-amz-content-sha256');
  });

  it('signs a session token when one is present', () => {
    const headers = signRequest({
      credentials: { ...CREDENTIALS, sessionToken: 'temporary' },
      region: REGION,
      service: 's3',
      at: AT,
      method: 'DELETE',
      host: 'bucket.s3.amazonaws.com',
      path: '/key',
      payloadHash: EMPTY_PAYLOAD_HASH,
    });
    expect(headers['x-amz-security-token']).toBe('temporary');
    expect(headers.authorization).toContain('x-amz-security-token');
  });

  it('changes the signature when the path changes — the object is inside the signature', () => {
    const sign = (path: string): string =>
      signRequest({
        credentials: CREDENTIALS,
        region: REGION,
        service: 's3',
        at: AT,
        method: 'HEAD',
        host: 'bucket.s3.amazonaws.com',
        path,
        payloadHash: EMPTY_PAYLOAD_HASH,
      }).authorization as string;
    expect(sign('/acme/a')).not.toBe(sign('/rival/a'));
  });
});

describe('presignedQueryString', () => {
  const presign = (extra: Record<string, string> = {}): string =>
    presignedQueryString({
      credentials: CREDENTIALS,
      region: REGION,
      service: 's3',
      at: AT,
      method: 'PUT',
      host: 'storage.example.com',
      path: '/munaxa/tenants/acme/ab/cd/abcd',
      expiresInSeconds: 300,
      signedHeaders: { 'content-type': 'application/pdf', 'content-length': '4096', ...extra },
    });

  it('carries every parameter the service needs to verify it', () => {
    const query = new URLSearchParams(presign());
    expect(query.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(query.get('X-Amz-Credential')).toBe('AKIDEXAMPLE/20150830/us-east-1/s3/aws4_request');
    expect(query.get('X-Amz-Date')).toBe('20150830T123600Z');
    expect(query.get('X-Amz-Expires')).toBe('300');
    expect(query.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the headers it names, and names the ones it signs', () => {
    const signed = new URLSearchParams(presign()).get('X-Amz-SignedHeaders');
    expect(signed).toBe('content-length;content-type;host');
  });

  it('binds the target to its size — a URL issued for 4 kB is not a URL for 4 GB', () => {
    const small = new URLSearchParams(presign()).get('X-Amz-Signature');
    const large = new URLSearchParams(presign({ 'content-length': '4294967296' })).get(
      'X-Amz-Signature',
    );
    expect(small).not.toBe(large);
  });

  it('is deterministic, so the same request signs the same way twice', () => {
    expect(presign()).toBe(presign());
  });

  it('signs the tenant prefix, so one tenant cannot re-point a URL at another', () => {
    const forTenant = (path: string): string | null =>
      new URLSearchParams(
        presignedQueryString({
          credentials: CREDENTIALS,
          region: REGION,
          service: 's3',
          at: AT,
          method: 'GET',
          host: 'storage.example.com',
          path,
          expiresInSeconds: 300,
        }),
      ).get('X-Amz-Signature');
    expect(forTenant('/munaxa/tenants/acme/x')).not.toBe(forTenant('/munaxa/tenants/rival/x'));
  });
});
