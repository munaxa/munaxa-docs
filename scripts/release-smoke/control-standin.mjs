#!/usr/bin/env node
// A local stand-in for munaxa-control's product-facing entitlements API, so the API runs its
// production licensing mode (LICENSING_MODE=CONTROL_PLANE, ADR-0026) in the release smoke without a
// deployed Control service. Production refuses LICENSING_MODE=NONE, so the smoke needs a licence
// source, and a licence file binds one tenant where the smoke runs two.
//
// It is a stand-in, not a licence: it answers every Docs tenant with a snapshot that includes every
// feature in this commit's catalogue (packages/domain/src/licensing.ts) with no limit, which is what
// NONE granted before. The API still reaches it the production way: https, a host on
// OUTBOUND_HTTP_ALLOWLIST, the service credential as a bearer token, and the shared response reading
// in @munaxa/licensing. Each request is appended to a JSON-lines file so run.sh can check that the
// API asked.
//
//   node scripts/release-smoke/control-standin.mjs <host> <port> <cert> <key> <log>
// The service credential is read from CONTROL_STANDIN_TOKEN, so it never appears in a process list.

import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:https';

const [host, port, certPath, keyPath, log] = process.argv.slice(2);
const token = process.env.CONTROL_STANDIN_TOKEN;
if (!host || !port || !certPath || !keyPath || !log || !token) {
  console.error(
    'usage: CONTROL_STANDIN_TOKEN=… control-standin.mjs <host> <port> <cert> <key> <log>',
  );
  process.exit(2);
}

/** The values of one `export const <name> = { … } as const;` block in the Docs catalogue. */
function catalogueKeys(source, name) {
  const block = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const;`).exec(source);
  const keys = block ? [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]) : [];
  if (keys.length === 0) throw new Error(`no ${name} keys found in the Docs catalogue`);
  return keys;
}

const catalogue = readFileSync(
  new URL('../../packages/domain/src/licensing.ts', import.meta.url),
  'utf8',
);
const features = catalogueKeys(catalogue, 'DocsFeature');
const limits = Object.fromEntries(catalogueKeys(catalogue, 'DocsLimit').map((key) => [key, null]));

const ENTITLEMENTS = /^\/api\/v1\/products\/docs\/tenants\/([^/]+)\/entitlements$/;
const USAGE = '/api/v1/products/docs/usage';

createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, (request, response) => {
  request.resume(); // A usage batch's body is acknowledged, not read.
  request.on('end', () => {
    const path = new URL(request.url ?? '/', 'https://standin').pathname;
    const authorized = request.headers.authorization === `Bearer ${token}`;
    appendFileSync(
      log,
      `${JSON.stringify({ at: new Date().toISOString(), method: request.method, path, authorized })}\n`,
    );
    if (!authorized) {
      response.writeHead(401).end();
      return;
    }
    const tenant = ENTITLEMENTS.exec(path);
    if (request.method === 'GET' && tenant) {
      const now = new Date().toISOString();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          schemaVersion: 1,
          customerId: 'release-smoke',
          tenantId: decodeURIComponent(tenant[1]),
          product: 'docs',
          deployment: 'SAAS',
          subscriptionId: 'release-smoke',
          plan: { code: 'release-smoke', version: 1 },
          status: 'ACTIVE',
          trialEndsAt: null,
          expiresAt: null,
          graceUntil: null,
          features,
          limits,
          resolvedAt: now,
        }),
      );
      return;
    }
    if (request.method === 'POST' && path === USAGE) {
      response.writeHead(202).end();
      return;
    }
    response.writeHead(404).end();
  });
}).listen(Number(port), host);
