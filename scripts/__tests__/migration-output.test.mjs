// L-6: migration output is streamed as the child produces it, redacted on the way, with bounded
// memory — and a stopped run stops what it started.
//
//   node --test scripts/__tests__/*.test.mjs
//
// The children here are small Node scripts standing in for the Prisma CLI, so the behaviour of the
// stream is tested exactly, without a database.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  EXIT,
  createRedactingWriter,
  lockConnectionUrl,
  lockWaitSeconds,
  redact,
  runStreaming,
  stopRunningChildren,
} from '../migration-support.mjs';

const URL_WITH_SECRET = 'postgresql://edms_owner:s3cr%40t-Pass-9f2@db.internal:5432/edms_acme';
const SECRETS = ['s3cr%40t-Pass-9f2', 's3cr@t-Pass-9f2'];

function collector() {
  const parts = [];
  return {
    parts,
    write: (text) => parts.push(text),
    get text() {
      return parts.join('');
    },
  };
}

/** Whether `pid` is a live process (an exited one awaiting its reaper counts as gone). */
function running(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^\d+ \(.*\) [ZX] /.test(stat);
  } catch {
    return false;
  }
}

function node(source, options = {}) {
  return runStreaming(process.execPath, ['-e', source], options);
}

function assertNoSecret(text) {
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), `a secret leaked: ${JSON.stringify(text.slice(0, 200))}`);
  }
  assert.doesNotMatch(text, /postgres(ql)?:\/\/[^*]/, 'a connection string leaked');
}

test('output reaches the log while the child is still running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-stream-'));
  const marker = join(dir, 'seen');
  try {
    const out = collector();
    // The child prints a line, then waits until the test has seen that line before it exits. Output
    // buffered until exit would never be seen, and this test would time out.
    const pending = node(
      `process.stdout.write('first line\\n');
       const fs = require('node:fs');
       const wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(marker)})) { clearInterval(wait); process.stdout.write('second line\\n'); } }, 20);`,
      {
        stdout: (text) => {
          out.write(text);
          if (text.includes('first line')) writeFileSync(marker, '');
        },
      },
    );
    const status = await pending;
    assert.equal(status, 0);
    assert.equal(out.text, '    first line\n    second line\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a partial line is held until its end arrives, and an unterminated last line is flushed', async () => {
  const out = collector();
  const status = await node(
    `const parts = ['Applying mig', 'ration \`2026_init\`', '\\nDone wi', 'thout a newline'];
     let i = 0; const next = () => { if (i < parts.length) { process.stdout.write(parts[i++]); setTimeout(next, 30); } }; next();`,
    { stdout: out.write },
  );
  assert.equal(status, 0);
  assert.equal(out.text, '    Applying migration `2026_init`\n    Done without a newline\n');
  // The complete line was written whole, as soon as its end arrived; the unterminated one at exit.
  assert.equal(out.parts[0], '    Applying migration `2026_init`\n');
});

test('a secret split between two chunks, at every possible position, is still redacted', () => {
  const line = `P1000: auth failed for ${SECRETS[1]} and ${SECRETS[0]} at ${URL_WITH_SECRET} (retry)\nnext\n`;
  for (let cut = 1; cut < line.length; cut += 1) {
    const out = collector();
    const writer = createRedactingWriter(out.write, [URL_WITH_SECRET]);
    writer.push(line.slice(0, cut));
    writer.push(line.slice(cut));
    writer.end();
    assertNoSecret(out.text);
    assert.match(
      out.text,
      /auth failed for \*\*\* and \*\*\* at postgresql:\/\/\*\*\* \(retry\)\nnext\n/,
    );
  }
});

test('a secret pushed one character at a time is redacted', () => {
  const text = `connection to ${URL_WITH_SECRET} failed; password ${SECRETS[1]}\n`;
  const out = collector();
  const writer = createRedactingWriter(out.write, [URL_WITH_SECRET]);
  for (const character of text) writer.push(character);
  writer.end();
  assertNoSecret(out.text);
  assert.equal(out.text, 'connection to postgresql://*** failed; password ***\n');
});

test('an over-long line is written in bounded pieces without cutting through a secret or a URL', () => {
  const filler = 'word '.repeat(20_000); // 100 000 characters, well over the 64 KiB buffer
  for (const offset of [0, 1, 7, 13, 64 * 1024 - 20, 64 * 1024 - 3]) {
    const text = `${filler.slice(0, offset)}${SECRETS[1]} ${URL_WITH_SECRET} ${filler}${SECRETS[0]}`;
    const out = collector();
    const writer = createRedactingWriter(out.write, [URL_WITH_SECRET]);
    for (let i = 0; i < text.length; i += 4093) writer.push(text.slice(i, i + 4093));
    writer.end();
    assertNoSecret(out.text);
    assert.ok(out.parts.length > 1, 'the line was written in pieces, not held whole');
    assert.ok(Math.max(...out.parts.map((part) => part.length)) <= 64 * 1024 + 4096);
  }
});

test('a huge run without whitespace is withheld, not cut, so no URL can be written in halves', () => {
  const run = `postgresql://edms_owner:${'x'.repeat(200_000)}@host/db`;
  const out = collector();
  const writer = createRedactingWriter(out.write, []);
  writer.push('before\n');
  for (let i = 0; i < run.length; i += 1000) writer.push(run.slice(i, i + 1000));
  writer.push(' after\n');
  writer.end();
  assert.match(
    out.text,
    /^before\n\[output withheld: more than \d+ characters without whitespace\]\n after\n$/,
  );
  assert.doesNotMatch(out.text, /xxxx|@host/);
});

test('large output streams through with bounded pieces and nothing lost', async () => {
  let lines = 0;
  let largest = 0;
  const status = await node(
    `const line = 'row ' + 'y'.repeat(200) + '\\n';
     let n = 0; const burst = () => { let ok = true; while (n < 50000 && ok) { ok = process.stdout.write(n++ + ' ' + line); } if (n < 50000) process.stdout.once('drain', burst); }; burst();`,
    {
      stdout: (text) => {
        largest = Math.max(largest, text.length);
        lines += text.split('\n').length - 1;
      },
    },
  );
  assert.equal(status, 0);
  assert.equal(lines, 50000);
  // About 10 MB went through; no single write held more than a pipe's worth plus a line.
  assert.ok(largest < 512 * 1024, `largest write ${largest}`);
});

test('a non-zero exit status is returned as it is; a signal or a missing program is 1', async () => {
  assert.equal(await node('process.exit(7)', { stdout: () => {}, stderr: () => {} }), 7);
  assert.equal(
    await node("process.kill(process.pid, 'SIGKILL')", { stdout: () => {}, stderr: () => {} }),
    1,
  );
  const err = collector();
  assert.equal(
    await runStreaming('/nonexistent/prisma-cli', [], { stdout: () => {}, stderr: err.write }),
    1,
  );
  assert.match(err.text, /could not start the child process \(ENOENT\)/);
});

test('no secret from the child environment reaches stdout or stderr, whatever the timing', async () => {
  const out = collector();
  const err = collector();
  const env = { ...process.env, DATABASE_URL: URL_WITH_SECRET };
  const status = await node(
    `const u = process.env.DATABASE_URL; const p = new URL(u).password; const d = decodeURIComponent(p);
     const pieces = ['error: ', u.slice(0, 20), u.slice(20), ' pw=', p.slice(0, 3), p.slice(3), ' raw=', d, '\\n'];
     let i = 0; const next = () => { if (i < pieces.length) { process.stdout.write(pieces[i]); process.stderr.write(pieces[i++]); setTimeout(next, 15); } else process.exit(3); }; next();`,
    { env, urls: [URL_WITH_SECRET], stdout: out.write, stderr: err.write },
  );
  assert.equal(status, 3);
  for (const text of [out.text, err.text]) {
    assertNoSecret(text);
    assert.equal(text, '    error: postgresql://*** pw=*** raw=***\n');
  }
});

test('stopping a run stops the child and everything it started, then resolves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mig-stop-'));
  const pidFile = join(dir, 'grandchild');
  try {
    const out = collector();
    // The child starts a grandchild (as the Prisma CLI starts its schema engine) and both run forever.
    const pending = node(
      `const { spawn } = require('node:child_process');
       const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
       require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
       process.stdout.write('started\\n'); setInterval(() => {}, 1000);`,
      { stdout: out.write },
    );
    while (!existsSync(pidFile) || !out.text.includes('started')) {
      await new Promise((resume) => setTimeout(resume, 20));
    }
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(running(grandchild));
    const started = Date.now();
    await stopRunningChildren(2_000);
    assert.equal(await pending, 1, 'a child ended by a signal is a failure');
    assert.ok(Date.now() - started < 2_000, 'SIGTERM was enough; no SIGKILL wait');
    await new Promise((resume) => setTimeout(resume, 100));
    assert.ok(!running(grandchild), 'the grandchild is gone too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lock wait accepts 0 to 3600 whole seconds and defaults to 120', () => {
  assert.equal(lockWaitSeconds(undefined), 120);
  assert.equal(lockWaitSeconds(''), 120);
  assert.equal(lockWaitSeconds('0'), 0);
  assert.equal(lockWaitSeconds('3600'), 3600);
  for (const value of ['3601', '-1', '2.5', 'ten', ' 5'])
    assert.equal(lockWaitSeconds(value), null);
});

test("the lock's connection is one named connection and keeps the URL's own parameters", () => {
  const url = new URL(lockConnectionUrl(`${URL_WITH_SECRET}?sslmode=require`));
  assert.equal(url.searchParams.get('connection_limit'), '1');
  assert.equal(url.searchParams.get('application_name'), 'munaxa-docs-migrate-lock');
  assert.equal(url.searchParams.get('sslmode'), 'require');
  assert.equal(url.password, 's3cr%40t-Pass-9f2');
});

test('the exit codes are the documented ones', () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, MIGRATION_FAILED: 1, CONFIGURATION: 2, LOCKED: 3 });
  assert.equal(redact('x', []), 'x');
});
