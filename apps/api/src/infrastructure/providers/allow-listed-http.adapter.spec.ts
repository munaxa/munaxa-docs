import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, globalAgent, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../core/config';
import { ControlPlaneLookup } from '../../core/licensing/control-plane.lookup';
import type { Logger } from '../../core/observability/logger';
import {
  AllowListedHttpAdapter,
  pinnedRequest,
  type OutboundTransport,
  type PinnedRequest,
} from './allow-listed-http.adapter';

/**
 * The adapter's TLS: a request is connected to the address the SSRF check approved, and the
 * certificate is still verified against the **hostname** the URL names.
 *
 * Until this suite, the request was made to the literal address with the name restored only in the
 * `Host` header, so TLS checked a hostname certificate against an IP and refused it
 * (`ERR_TLS_CERT_ALTNAME_INVALID`): every https destination the allow-list permitted, the Control
 * plane and webhook receivers alike, was unreachable in practice.
 *
 * Real TLS against a local server: a CA made for the run, trusted only through the global agent
 * for the duration of the suite, and certificates for names that do not exist in DNS, so a request
 * that succeeds can only have connected through the pinned address.
 */

const directory = mkdtempSync(join(tmpdir(), 'outbound-tls-'));

/** A CA, and a leaf it signs for `name` (a DNS name), as PEM. */
function certificates(): { ca: string; leaf: (name: string) => { cert: string; key: string } } {
  const file = (name: string) => join(directory, name);
  const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'pipe' });
  openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file('ca.key')]);
  openssl([
    'req',
    '-x509',
    '-new',
    '-key',
    file('ca.key'),
    '-subj',
    '/CN=outbound test CA',
    '-days',
    '1',
    '-out',
    file('ca.pem'),
  ]);
  return {
    ca: readFileSync(file('ca.pem'), 'utf8'),
    leaf: (name) => {
      openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', file(`${name}.key`)]);
      openssl([
        'req',
        '-new',
        '-key',
        file(`${name}.key`),
        '-subj',
        `/CN=${name}`,
        '-out',
        file(`${name}.csr`),
      ]);
      writeFileSync(
        file(`${name}.ext`),
        `subjectAltName=DNS:${name}\nextendedKeyUsage=serverAuth\n`,
      );
      openssl([
        'x509',
        '-req',
        '-in',
        file(`${name}.csr`),
        '-CA',
        file('ca.pem'),
        '-CAkey',
        file('ca.key'),
        '-CAcreateserial',
        '-days',
        '1',
        '-extfile',
        file(`${name}.ext`),
        '-out',
        file(`${name}.pem`),
      ]);
      return {
        cert: readFileSync(file(`${name}.pem`), 'utf8'),
        key: readFileSync(file(`${name}.key`), 'utf8'),
      };
    },
  };
}

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

function adapter(options: {
  readonly allowList: readonly string[];
  readonly resolve: (host: string) => Promise<readonly string[]>;
  readonly transport: OutboundTransport;
}): AllowListedHttpAdapter {
  return new AllowListedHttpAdapter(
    {
      outbound: { allowList: options.allowList, allowInsecure: false, maxResponseBytes: 65_536 },
    } as unknown as AppConfig,
    silent,
    options.transport,
    options.resolve,
  );
}

/**
 * The real transport, with the route to the internet replaced by a route to this machine: the
 * public address the adapter approved is where the request is *addressed*, `127.0.0.1` is where it
 * physically lands. Everything else — the hostname, SNI, the certificate check — is the real path.
 */
function routedTo(local: string, seen: PinnedRequest[]): OutboundTransport {
  return (request) => {
    seen.push(request);
    return pinnedRequest({ ...request, address: local });
  };
}

let ca: ReturnType<typeof certificates>;
const servers: Server[] = [];
const caBefore = globalAgent.options.ca;

/** An https server on 127.0.0.1 presenting a certificate for `name`; resolves to its port. */
async function serve(
  name: string,
  handler: Parameters<typeof createServer>[1] = (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' }).end(`hello from ${name}`);
  },
): Promise<number> {
  const server = createServer(ca.leaf(name), handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

beforeAll(() => {
  ca = certificates();
  globalAgent.options.ca = ca.ca;
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

afterAll(() => {
  globalAgent.options.ca = caBefore;
  rmSync(directory, { recursive: true, force: true });
});

const signal = () => new AbortController().signal;

describe('pinnedRequest — the hostname is verified, the address is pinned', () => {
  it('accepts a valid certificate for the requested hostname over the pinned address', async () => {
    const port = await serve('control.munaxa.test');
    // `control.munaxa.test` does not exist in DNS: only the pinned lookup can have connected this.
    const response = await pinnedRequest({
      url: new URL(`https://control.munaxa.test:${String(port)}/hello`),
      address: '127.0.0.1',
      method: 'GET',
      headers: {},
      signal: signal(),
      maxResponseBytes: 1_024,
    });
    expect(response).toEqual({ status: 200, body: 'hello from control.munaxa.test' });
  });

  it('rejects a certificate issued for a different hostname', async () => {
    const port = await serve('somebody-else.test');
    await expect(
      pinnedRequest({
        url: new URL(`https://control.munaxa.test:${String(port)}/hello`),
        address: '127.0.0.1',
        method: 'GET',
        headers: {},
        signal: signal(),
        maxResponseBytes: 1_024,
      }),
    ).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  });

  it('rejects a certificate from an issuer nobody trusts', async () => {
    const port = await serve('control.munaxa.test');
    globalAgent.options.ca = undefined;
    try {
      await expect(
        pinnedRequest({
          url: new URL(`https://control.munaxa.test:${String(port)}/hello`),
          address: '127.0.0.1',
          method: 'GET',
          headers: {},
          signal: signal(),
          maxResponseBytes: 1_024,
        }),
      ).rejects.toThrow(/unable to verify|self[- ]signed/i);
    } finally {
      globalAgent.options.ca = ca.ca;
    }
  });

  it('sends a body with its length, as fetch did', async () => {
    let received: { length: string | undefined; chunked: string | undefined; body: string } | null =
      null;
    const port = await serve('hooks.example.test', (request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        received = {
          length: request.headers['content-length'],
          chunked: request.headers['transfer-encoding'],
          body,
        };
        response.writeHead(204).end();
      });
    });
    await pinnedRequest({
      url: new URL(`https://hooks.example.test:${String(port)}/edms`),
      address: '127.0.0.1',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"event":"é"}',
      signal: signal(),
      maxResponseBytes: 1_024,
    });
    expect(received).toEqual({ length: '14', chunked: undefined, body: '{"event":"é"}' });
  });

  it('does not follow a redirect', async () => {
    const port = await serve('hooks.example.test', (_request, response) => {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    });
    const response = await pinnedRequest({
      url: new URL(`https://hooks.example.test:${String(port)}/edms`),
      address: '127.0.0.1',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: signal(),
      maxResponseBytes: 1_024,
    });
    expect(response.status).toBe(302);
  });

  it('keeps no more of a response than it was asked to', async () => {
    const port = await serve('hooks.example.test', (_request, response) => {
      response.writeHead(200).end('x'.repeat(100_000));
    });
    const response = await pinnedRequest({
      url: new URL(`https://hooks.example.test:${String(port)}/edms`),
      address: '127.0.0.1',
      method: 'GET',
      headers: {},
      signal: signal(),
      maxResponseBytes: 1_024,
    });
    expect(response.body.length).toBeLessThan(100_000);
  });
});

describe('AllowListedHttpAdapter — the outbound checks still decide', () => {
  const answers = new Map<string, readonly string[]>([
    ['control.munaxa.test', ['93.184.216.34']],
    ['hooks.example.test', ['93.184.216.35']],
    ['rebind.example.test', ['127.0.0.1']],
  ]);
  const resolve = (host: string) => Promise.resolve(answers.get(host) ?? []);

  it('hands the transport the hostname and the checked address, and verifies TLS by name', async () => {
    const port = await serve('hooks.example.test');
    const seen: PinnedRequest[] = [];
    const outbound = adapter({
      allowList: ['hooks.example.test'],
      resolve,
      transport: routedTo('127.0.0.1', seen),
    });

    const result = await outbound.send({
      url: `https://hooks.example.test:${String(port)}/edms`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"event":"document.created"}',
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ ok: true, response: { status: 200 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url.hostname).toBe('hooks.example.test');
    expect(seen[0]?.address).toBe('93.184.216.35');
  });

  it('reports a certificate for the wrong name as a network failure, never as a response', async () => {
    const port = await serve('somebody-else.test');
    const outbound = adapter({
      allowList: ['hooks.example.test'],
      resolve,
      transport: routedTo('127.0.0.1', []),
    });
    const result = await outbound.send({
      url: `https://hooks.example.test:${String(port)}/edms`,
      method: 'POST',
      body: '{}',
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'NETWORK' } });
  });

  it('opens no connection for a host off the allow-list, a private resolution, or http', async () => {
    const seen: PinnedRequest[] = [];
    const outbound = adapter({
      allowList: ['rebind.example.test'],
      resolve,
      transport: routedTo('127.0.0.1', seen),
    });
    for (const url of [
      'https://hooks.example.test/edms',
      'https://rebind.example.test/edms',
      'http://rebind.example.test/edms',
    ]) {
      const result = await outbound.send({ url, method: 'GET', timeoutMs: 1_000 });
      expect(result).toMatchObject({ ok: false, failure: { kind: 'REFUSED' } });
    }
    expect(seen).toHaveLength(0);
  });

  it('reads Control-plane entitlements over verified TLS (LICENSING_MODE=CONTROL_PLANE)', async () => {
    const tenantId = '019489f0-0000-7000-8000-000000000001';
    let authorization: string | undefined;
    const port = await serve('control.munaxa.test', (request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          schemaVersion: 1,
          customerId: 'cus_1',
          tenantId,
          product: 'docs',
          deployment: 'SAAS',
          subscriptionId: 'sub_1',
          plan: { code: 'business', version: 1 },
          status: 'ACTIVE',
          trialEndsAt: null,
          expiresAt: null,
          graceUntil: null,
          features: ['api.access'],
          limits: { users: 50 },
          resolvedAt: '2026-10-29T00:00:00.000Z',
        }),
      );
    });
    const lookup = new ControlPlaneLookup(
      adapter({
        allowList: ['control.munaxa.test'],
        resolve,
        transport: routedTo('127.0.0.1', []),
      }),
      { url: `https://control.munaxa.test:${String(port)}`, token: 'k'.repeat(40) },
    );

    const answer = await lookup.lookup(tenantId);

    expect(answer).toMatchObject({
      kind: 'SNAPSHOT',
      snapshot: { tenantId, plan: { code: 'business' } },
    });
    expect(authorization).toBe(`Bearer ${'k'.repeat(40)}`);
  });

  it('treats a Control endpoint presenting the wrong certificate as unreachable, not as "no subscription"', async () => {
    const port = await serve('somebody-else.test');
    const lookup = new ControlPlaneLookup(
      adapter({
        allowList: ['control.munaxa.test'],
        resolve,
        transport: routedTo('127.0.0.1', []),
      }),
      { url: `https://control.munaxa.test:${String(port)}`, token: 'k'.repeat(40) },
    );
    expect(await lookup.lookup('019489f0-0000-7000-8000-000000000001')).toMatchObject({
      kind: 'UNAVAILABLE',
    });
  });
});
