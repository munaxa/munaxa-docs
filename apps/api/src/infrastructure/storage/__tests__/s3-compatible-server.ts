import { createHash, createHmac } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { canonicalize, credentialScope, signingKey } from '../sigv4';

/**
 * An S3-compatible store, in process, that actually verifies what it is sent.
 *
 * The point is not to simulate S3. It is to make the adapter's own wiring falsifiable without
 * MinIO: that the URL it hands a browser is the URL it signed, that the host and path it put in the
 * canonical request are the ones the request arrives on, that the tenant prefix survives into the
 * object key, and that an edited URL stops verifying. Every one of those is a mistake a
 * hand-written signer can make and no unit test over the signer itself would catch, because the
 * signer would be asked the same wrong question twice.
 *
 * It re-derives the signature from the request as received and compares. A request whose URL has
 * been altered after signing therefore fails here exactly as it would at AWS — which is the
 * property the suite asserts.
 *
 * `sigv4.spec.ts` is what pins the *algorithm* to AWS's published vectors. This pins the adapter to
 * the algorithm.
 */
export interface StoredObject {
  readonly body: Buffer;
  readonly contentType: string;
  readonly lastModified: Date;
}

export interface S3CompatibleServer {
  readonly url: string;
  readonly objects: Map<string, StoredObject>;
  /** Every request the adapter made, for asserting what it did rather than only what came back. */
  readonly requests: { method: string; path: string; authorized: 'query' | 'header' | 'none' }[];
  close(): Promise<void>;
}

export interface ServerCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
}

export async function startS3CompatibleServer(
  credentials: ServerCredentials,
  bucket: string,
): Promise<S3CompatibleServer> {
  const objects = new Map<string, StoredObject>();
  const requests: S3CompatibleServer['requests'] = [];
  let nextUploadId = 1;

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const body = await readBody(request);
    const authorized = authorizationStyle(request.headers.authorization, url);
    requests.push({ method: request.method ?? '', path: url.pathname, authorized });

    if (!verify(request.method ?? '', url, request.headers, body, credentials)) {
      response.writeHead(403, { 'content-type': 'application/xml' });
      response.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }

    // Path-style addressing: the first segment is the bucket. The adapter is configured for it in
    // the suite, so a request that arrived without it is the adapter getting addressing wrong.
    const segments = decodeURIComponent(url.pathname).replace(/^\//, '').split('/');
    if (segments[0] !== bucket) {
      response.writeHead(404).end();
      return;
    }
    const key = segments.slice(1).join('/');

    if (url.searchParams.has('uploads')) {
      const uploadId = `upload-${String(nextUploadId++)}`;
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end(
        `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
      );
      return;
    }
    if (url.searchParams.has('uploadId') && request.method === 'POST') {
      response.writeHead(200, { 'content-type': 'application/xml' });
      response.end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
      return;
    }

    switch (request.method) {
      case 'PUT': {
        const source = request.headers['x-amz-copy-source'];
        if (typeof source === 'string') {
          const from = decodeURIComponent(source).replace(`/${bucket}/`, '');
          const existing = objects.get(from);
          if (existing === undefined) {
            response.writeHead(404).end();
            return;
          }
          objects.set(key, existing);
          response.writeHead(200).end('<CopyObjectResult/>');
          return;
        }
        const part = url.searchParams.get('partNumber');
        objects.set(part === null ? key : `${key}#part${part}`, {
          body,
          contentType: String(request.headers['content-type'] ?? 'application/octet-stream'),
          lastModified: new Date(),
        });
        response
          .writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` })
          .end();
        return;
      }
      case 'HEAD':
      case 'GET': {
        const stored = objects.get(key);
        if (stored === undefined) {
          response.writeHead(404).end();
          return;
        }
        const headers: Record<string, string> = {
          'content-length': String(stored.body.length),
          'content-type': stored.contentType,
          'last-modified': stored.lastModified.toUTCString(),
          'x-amz-checksum-sha256': createHash('sha256').update(stored.body).digest('base64'),
        };
        const disposition = url.searchParams.get('response-content-disposition');
        if (disposition !== null) {
          headers['content-disposition'] = disposition;
        }
        response.writeHead(200, headers);
        response.end(request.method === 'HEAD' ? undefined : stored.body);
        return;
      }
      case 'DELETE': {
        objects.delete(key);
        response.writeHead(204).end();
        return;
      }
      default:
        response.writeHead(405).end();
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    objects,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function authorizationStyle(
  authorization: string | undefined,
  url: URL,
): 'query' | 'header' | 'none' {
  if (authorization !== undefined) {
    return 'header';
  }
  return url.searchParams.has('X-Amz-Signature') ? 'query' : 'none';
}

/** Re-derives the signature from the request as received, both styles. */
function verify(
  method: string,
  url: URL,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  body: Buffer,
  credentials: ServerCredentials,
): boolean {
  const presigned = url.searchParams.get('X-Amz-Signature');
  return presigned === null
    ? verifyHeader(method, url, headers, body, credentials)
    : verifyQuery(method, url, headers, credentials, presigned);
}

function verifyQuery(
  method: string,
  url: URL,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  credentials: ServerCredentials,
  presented: string,
): boolean {
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (name !== 'X-Amz-Signature') {
      query[name] = value;
    }
  }
  const signedNames = (query['X-Amz-SignedHeaders'] ?? 'host').split(';');
  const signedHeaders: Record<string, string> = {};
  for (const name of signedNames) {
    signedHeaders[name] = String(headers[name] ?? (name === 'host' ? url.host : ''));
  }
  const stamp = query['X-Amz-Date'] ?? '';
  const { text } = canonicalize({
    method,
    path: encodeURI(url.pathname),
    query,
    headers: signedHeaders,
    payloadHash: 'UNSIGNED-PAYLOAD',
  });
  return presented === derive(text, stamp, credentials);
}

function verifyHeader(
  method: string,
  url: URL,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  body: Buffer,
  credentials: ServerCredentials,
): boolean {
  const authorization = String(headers.authorization ?? '');
  const signedNames = /SignedHeaders=([^,]+)/.exec(authorization)?.[1]?.split(';') ?? [];
  const presented = /Signature=([0-9a-f]+)/.exec(authorization)?.[1] ?? '';
  const signedHeaders: Record<string, string> = {};
  for (const name of signedNames) {
    signedHeaders[name] = String(headers[name] ?? (name === 'host' ? url.host : ''));
  }
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    query[name] = value;
  }
  const payloadHash = String(
    headers['x-amz-content-sha256'] ?? createHash('sha256').update(body).digest('hex'),
  );
  const { text } = canonicalize({
    method,
    path: encodeURI(url.pathname),
    query,
    headers: signedHeaders,
    payloadHash,
  });
  return presented === derive(text, String(headers['x-amz-date'] ?? ''), credentials);
}

function derive(canonicalRequest: string, stamp: string, credentials: ServerCredentials): string {
  const short = stamp.slice(0, 8);
  const toSign = [
    'AWS4-HMAC-SHA256',
    stamp,
    credentialScope(short, credentials.region, 's3'),
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  return createHmac(
    'sha256',
    signingKey(credentials.secretAccessKey, short, credentials.region, 's3'),
  )
    .update(toSign)
    .digest('hex');
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
