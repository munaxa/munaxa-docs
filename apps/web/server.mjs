// The web tier's HTTP server: Next.js, with one thing added in front of it.
//
// Sign-in is a server action, so the API sees this process as the client for every browser — and the
// sign-in rate limit, which is per address, would be spent by the whole deployment together (the
// release candidate's D-2). To forward the browser's address instead, this process has to know it,
// and inside a server action it cannot: Next.js only fills `X-Forwarded-For` when the request did not
// already carry one, so a browser that sends its own is believed, and the socket's address is lost.
//
// So the address is resolved here, where the socket is still in hand, under `WEB_TRUST_PROXY` — the
// same rule and the same syntax as the API's `TRUST_PROXY`, and the same default of trusting nothing.
// It is written into one header on every request, replacing whatever arrived under that name, and
// the process marks itself as having done so; the sign-in action forwards the address only when that
// mark is present. Everything else is `next start`: same build, same port handling, all interfaces.

import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLIENT_ADDRESS_HEADER,
  CLIENT_ADDRESS_STAMPED_ENV,
  ProxyTrustError,
  clientAddressOf,
  compileProxyTrust,
  parseProxyTrust,
} from '@edms/utils/proxy-trust';

function portFromArguments() {
  const index = process.argv.findIndex((argument) => argument === '--port' || argument === '-p');
  const value = index >= 0 ? process.argv[index + 1] : process.env.PORT;
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    process.stderr.write(`Not a port: ${String(value)}\n`);
    process.exit(1);
  }
  return port;
}

let trust;
try {
  trust = parseProxyTrust(process.env.WEB_TRUST_PROXY);
} catch (error) {
  process.stderr.write(
    `WEB_TRUST_PROXY: ${error instanceof ProxyTrustError ? error.message : 'not a proxy setting.'}\n`,
  );
  process.exit(1);
}
const trusted = compileProxyTrust(trust);
const port = portFromArguments();

process.env[CLIENT_ADDRESS_STAMPED_ENV] = '1';
// As `next start` does, and before Next.js is loaded, because some of it reads this at import time.
process.env.NODE_ENV ||= 'production';
const { default: next } = await import('next');

const app = next({ dev: false, dir: dirname(fileURLToPath(import.meta.url)), port });
const handle = app.getRequestHandler();
await app.prepare();

createServer((request, response) => {
  const address = clientAddressOf(
    request.socket.remoteAddress,
    request.headers['x-forwarded-for'],
    trusted,
  );
  if (address === undefined) {
    delete request.headers[CLIENT_ADDRESS_HEADER];
  } else {
    request.headers[CLIENT_ADDRESS_HEADER] = address;
  }
  void handle(request, response);
}).listen(port, () => {
  process.stdout.write(`Munaxa Docs web on port ${String(port)} (proxy trust: ${trust.kind})\n`);
});
