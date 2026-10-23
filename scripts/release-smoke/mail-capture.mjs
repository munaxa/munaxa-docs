#!/usr/bin/env node
// A local stand-in for Resend's `POST /emails`, so the API runs its production mail driver
// (MAIL_DRIVER=RESEND) in the release smoke without a provider account, a key or a real recipient.
// Each request is appended to a JSON-lines file; the reply is the shape Resend acknowledges with.
//
//   node scripts/release-smoke/mail-capture.mjs <host> <port> <file>

import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const [host = '127.0.0.1', port = '8025', file = 'mail.jsonl'] = process.argv.slice(2);

createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    if (request.method !== 'POST' || request.url !== '/emails') {
      response.writeHead(404).end();
      return;
    }
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), body })}\n`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: randomUUID() }));
  });
}).listen(Number(port), host);
