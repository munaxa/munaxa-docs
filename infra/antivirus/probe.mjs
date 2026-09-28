#!/usr/bin/env node
// Is the ICAP antivirus service really scanning? — RC D-3.
//
//   node infra/antivirus/probe.mjs [icap://127.0.0.1:1344/avscan] [--wait SECONDS]
//
// Two RESPMOD requests, the same way the API's ICAP adapter sends them (empty preview, then the
// body): a harmless payload must come back `204`, and the EICAR test file must come back blocked
// with a named threat. Both, because a scanner that answers `204` to everything looks perfectly
// healthy to a clean-only check — c-icap does exactly that for any type group it was not told to
// scan. Exits 0 only when both hold; with `--wait`, retries until then or until the deadline.
//
// EICAR is the industry's harmless test file, assembled here at runtime so this file is not itself
// detected.
import net from 'node:net';

const args = process.argv.slice(2);
const waitIndex = args.indexOf('--wait');
const waitSeconds = waitIndex >= 0 ? Number(args[waitIndex + 1]) : 0;
const target = new URL(args.find((arg) => arg.startsWith('icap://')) ?? 'icap://127.0.0.1:1344/avscan');
const host = target.hostname;
const port = Number(target.port || 1344);
const service = `${target.pathname}${target.search}`;

const EICAR = Buffer.from(
  ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'].join(''),
  'latin1',
);
const CLEAN = Buffer.from('munaxa-docs scanner probe: nothing to see here\n', 'latin1');

function respmod(body) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    let received = Buffer.alloc(0);
    let continued = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('timed out'));
    }, 30_000);
    const reqHdr = 'GET /scan HTTP/1.1\r\nHost: munaxa-docs.invalid\r\n\r\n';
    const resHdr = `HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: ${body.length}\r\n\r\n`;
    socket.on('connect', () => {
      socket.write(
        `RESPMOD icap://${host}:${port}${service} ICAP/1.0\r\nHost: ${host}:${port}\r\nAllow: 204\r\n` +
          `Preview: 0\r\nConnection: close\r\nEncapsulated: req-hdr=0, res-hdr=${reqHdr.length}, ` +
          `res-body=${reqHdr.length + resHdr.length}\r\n\r\n${reqHdr}${resHdr}0\r\n\r\n`,
      );
    });
    socket.on('data', (data) => {
      received = Buffer.concat([received, data]);
      for (let end = received.indexOf('\r\n\r\n'); end >= 0; end = received.indexOf('\r\n\r\n')) {
        const head = received.subarray(0, end).toString('latin1');
        received = received.subarray(end + 4);
        if (head.startsWith('ICAP/1.0 100') && !continued) {
          continued = true;
          socket.write(Buffer.concat([Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n0\r\n\r\n')]));
          continue;
        }
        clearTimeout(timer);
        socket.destroy();
        resolve(head);
        return;
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function check() {
  const clean = await respmod(CLEAN);
  if (!clean.startsWith('ICAP/1.0 204')) {
    throw new Error(`a harmless payload was not passed: ${clean.split('\r\n')[0]}`);
  }
  const infected = await respmod(EICAR);
  const threat = /X-Infection-Found:.*Threat=([^;]+)/i.exec(infected)?.[1];
  if (!infected.startsWith('ICAP/1.0 200') || threat === undefined) {
    throw new Error(`EICAR was not blocked: ${infected.split('\r\n')[0]}`);
  }
  return threat;
}

const deadline = Date.now() + waitSeconds * 1000;
for (;;) {
  try {
    const threat = await check();
    console.log(`scanner ${target.href}: clean passed (204), EICAR blocked (${threat})`);
    process.exit(0);
  } catch (error) {
    if (Date.now() >= deadline) {
      console.error(`scanner ${target.href} is not scanning: ${error.message}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
