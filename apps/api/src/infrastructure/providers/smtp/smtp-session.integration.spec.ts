import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { TLSSocket, createSecureContext } from 'node:tls';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { NotificationChannel } from '@edms/domain';

import { SmtpMailAdapter } from './smtp-mail.adapter';
import { SmtpError, SmtpSession, type SmtpOptions } from './smtp-session';

/**
 * The SMTP client against a socket, driven by transcripts of what real servers answer.
 *
 * ## Why this suite is the whole of Phase 12's answer
 *
 * Phase 12 refused to build this adapter, and its stated reason was that *"an SMTP adapter cannot
 * be exercised anywhere this repository builds"*. That is an argument about evidence and it is
 * answered by producing evidence, so this file exists to be exactly that.
 *
 * The server below is not a mail server and does not try to be. It is a **transcript player**: it
 * replays a scripted sequence of replies and records every byte the client wrote. That is
 * deliberately not "a server I also wrote, agreeing with my client", which would assert nothing —
 * the scripts are what Postfix, Exchange Online and a small relay actually answer, and the
 * assertions are about the bytes this client puts on the wire and the branch it takes.
 *
 * What it therefore does **not** prove is that a real MTA accepts those bytes, and the phase report
 * says so rather than implying otherwise. What bounds that gap is that every branch here is defined
 * by RFC 5321 rather than by a vendor: a 2xx, a 4xx, a 5xx, a multi-line greeting, an `EHLO` a
 * server refuses, an `AUTH` list, a server with no `STARTTLS`.
 *
 * It runs in the integration suite rather than the unit one because it opens a loopback socket.
 */

const CRLF = '\r\n';

/** A scripted exchange: for each client turn, what the server answers. */
interface Transcript {
  /** Replies in order, one per client write. The first is the greeting, sent unprompted. */
  readonly replies: readonly string[];
  /** Close after this many client writes, to model a server that hangs up. */
  readonly hangUpAfter?: number;
  /**
   * Upgrade to TLS after this many client writes — the server half of STARTTLS.
   *
   * Real, not simulated: the socket is wrapped in a `TLSSocket` with the fixture certificate, so
   * everything after it is genuinely encrypted and the client's own `tls.connect` has to succeed.
   */
  readonly upgradeAfter?: number;
}

/**
 * A throwaway certificate for `localhost`, so the STARTTLS upgrade and the credential path run
 * against a **real** handshake rather than a claim about one. `__fixtures__/README.md` argues why
 * committing it is not the thing 17 §10 prohibits.
 */
const TLS_CONTEXT = createSecureContext({
  cert: readFileSync(join(__dirname, '__fixtures__', 'test-relay.cert.pem')),
  key: readFileSync(join(__dirname, '__fixtures__', 'test-relay.key.pem')),
});

interface Recording {
  readonly server: Server;
  readonly port: number;
  readonly written: string[];
  close(): Promise<void>;
}

let recording: Recording | null = null;

afterEach(async () => {
  await recording?.close();
  recording = null;
});

async function transcriptServer(transcript: Transcript): Promise<Recording> {
  const written: string[] = [];
  // Tracked so `close()` can destroy them: `net.Server#close` waits for every open socket, so a
  // test whose client failed mid-conversation would hang the suite in `afterEach` rather than
  // reporting the failure. (`closeAllConnections` is `http.Server`'s, not this one's.)
  const connections: Socket[] = [];
  const server = createServer((socket: Socket) => {
    connections.push(socket);
    let turn = 0;
    let channel: Socket | TLSSocket = socket;

    const onData = (chunk: Buffer): void => {
      written.push(chunk.toString('utf8'));
      turn += 1;
      if (transcript.hangUpAfter !== undefined && turn >= transcript.hangUpAfter) {
        channel.destroy();
        return;
      }
      const reply = transcript.replies[turn];
      if (reply !== undefined) {
        channel.write(reply);
      }
      if (transcript.upgradeAfter === turn) {
        // The reply above was the `220 Ready to start TLS`, and everything after this byte is
        // encrypted. The plain socket's listeners go first, or both would read the handshake.
        socket.removeAllListeners('data');
        const secured = new TLSSocket(socket, { isServer: true, secureContext: TLS_CONTEXT });
        secured.on('data', onData);
        secured.on('error', () => undefined);
        channel = secured;
      }
    };

    socket.write(transcript.replies[0] ?? `220 test${CRLF}`);
    socket.on('data', onData);
    // The client's own errors are its business; a destroyed socket must not take the suite down.
    socket.on('error', () => undefined);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  const created: Recording = {
    server,
    port,
    written,
    close: () =>
      new Promise<void>((resolve) => {
        for (const connection of connections) {
          connection.destroy();
        }
        server.close(() => {
          resolve();
        });
      }),
  };
  recording = created;
  return created;
}

function optionsFor(port: number, overrides: Partial<SmtpOptions> = {}): SmtpOptions {
  return {
    host: '127.0.0.1',
    port,
    security: 'NONE',
    username: null,
    password: null,
    clientName: 'docs.example.com',
    timeoutMs: 5_000,
    rejectUnauthorized: true,
    ...overrides,
  };
}

/** Postfix's ordinary happy path, verbatim down to the queue identifier. */
const POSTFIX_ACCEPTS: Transcript = {
  replies: [
    `220 mail.example.com ESMTP Postfix (Ubuntu)${CRLF}`,
    // A multi-line EHLO reply, which is the framing defect this client had to get right.
    `250-mail.example.com${CRLF}250-PIPELINING${CRLF}250-SIZE 10240000${CRLF}250-STARTTLS${CRLF}250-ENHANCEDSTATUSCODES${CRLF}250-8BITMIME${CRLF}250 CHUNKING${CRLF}`,
    `250 2.1.0 Ok${CRLF}`,
    `250 2.1.5 Ok${CRLF}`,
    `354 End data with <CR><LF>.<CR><LF>${CRLF}`,
    `250 2.0.0 Ok: queued as 4Wq3xy1Z2k${CRLF}`,
    `221 2.0.0 Bye${CRLF}`,
  ],
};

/**
 * A relay that offers STARTTLS, upgrades, and only then advertises `AUTH`.
 *
 * The handshake occupies no turn: `TLSSocket` consumes those bytes internally, so the next thing
 * the server's recorder sees after the upgrade is the second `EHLO` — already decrypted, which is
 * what makes its arrival the proof that the upgrade completed.
 */
const STARTTLS_THEN_AUTH_PLAIN: Transcript = {
  upgradeAfter: 2,
  replies: [
    `220 smtp.example.com ESMTP${CRLF}`,
    `250-smtp.example.com${CRLF}250-8BITMIME${CRLF}250 STARTTLS${CRLF}`,
    `220 2.0.0 Ready to start TLS${CRLF}`,
    `250-smtp.example.com${CRLF}250-AUTH PLAIN LOGIN${CRLF}250 8BITMIME${CRLF}`,
    `235 2.7.0 Authentication successful${CRLF}`,
    `250 Ok${CRLF}`,
    `250 Ok${CRLF}`,
    `354 Go ahead${CRLF}`,
    `250 Ok${CRLF}`,
    `221 Bye${CRLF}`,
  ],
};

describe('an SMTP conversation', () => {
  it('sends the commands in order and reports the queue identifier', async () => {
    const server = await transcriptServer(POSTFIX_ACCEPTS);

    const reply = await new SmtpSession(optionsFor(server.port)).send({
      envelopeFrom: 'docs@example.com',
      envelopeTo: 'ada@example.com',
      message: `Subject: hello${CRLF}${CRLF}body`,
    });

    expect(reply.code).toBe(250);
    expect(server.written[0]).toBe(`EHLO docs.example.com${CRLF}`);
    expect(server.written[1]).toBe(`MAIL FROM:<docs@example.com>${CRLF}`);
    expect(server.written[2]).toBe(`RCPT TO:<ada@example.com>${CRLF}`);
    expect(server.written[3]).toBe(`DATA${CRLF}`);
    expect(server.written[4]).toContain(`${CRLF}.${CRLF}`);
  });

  it('reads a multi-line reply as one reply', async () => {
    // The classic hand-rolled-client defect: treating `250-PIPELINING` as the answer leaves six
    // lines in the buffer, and every command after it reads the previous command's leftovers —
    // which shows up as `MAIL FROM` succeeding because it read the greeting's last line.
    const server = await transcriptServer(POSTFIX_ACCEPTS);

    await new SmtpSession(optionsFor(server.port)).send({
      envelopeFrom: 'docs@example.com',
      envelopeTo: 'ada@example.com',
      message: 'body',
    });

    // Four commands plus the payload plus QUIT, and no more: a desynchronised client sends the
    // same commands but reads the wrong replies, which this count would not catch — the ordering
    // assertions above are what catch it, and this catches a client that gave up early.
    expect(server.written).toHaveLength(6);
    expect(server.written[5]).toBe(`QUIT${CRLF}`);
  });

  it('classifies a 5xx as permanent — the mailbox does not exist', async () => {
    const server = await transcriptServer({
      replies: [
        `220 mail.example.com ESMTP${CRLF}`,
        `250 mail.example.com${CRLF}`,
        `250 2.1.0 Ok${CRLF}`,
        `550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown${CRLF}`,
      ],
    });

    const failure = await new SmtpSession(optionsFor(server.port))
      .send({
        envelopeFrom: 'docs@example.com',
        envelopeTo: 'nobody@example.com',
        message: 'body',
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmtpError);
    expect((failure as SmtpError).permanent).toBe(true);
    expect((failure as SmtpError).code).toBe(550);
  });

  it('classifies a 4xx as transient — a greylisted first attempt', async () => {
    // Greylisting is the reason this distinction is not academic: a correctly configured relay
    // refuses a first attempt from an unknown sender with a 4xx and accepts the retry. Treating
    // it as permanent would suppress every new recipient in the deployment.
    const server = await transcriptServer({
      replies: [
        `220 mail.example.com ESMTP${CRLF}`,
        `250 mail.example.com${CRLF}`,
        `250 2.1.0 Ok${CRLF}`,
        `451 4.7.1 Greylisted, try again in 300 seconds${CRLF}`,
      ],
    });

    const failure = await new SmtpSession(optionsFor(server.port))
      .send({ envelopeFrom: 'docs@example.com', envelopeTo: 'ada@example.com', message: 'b' })
      .catch((error: unknown) => error);

    expect((failure as SmtpError).permanent).toBe(false);
  });

  it('falls back to HELO when the server refuses EHLO', async () => {
    const server = await transcriptServer({
      replies: [
        `220 relay.example.com SMTP${CRLF}`,
        `500 Command not recognized${CRLF}`,
        `250 relay.example.com${CRLF}`,
        `250 Ok${CRLF}`,
        `250 Ok${CRLF}`,
        `354 Start mail input${CRLF}`,
        `250 Ok${CRLF}`,
        `221 Bye${CRLF}`,
      ],
    });

    await new SmtpSession(optionsFor(server.port)).send({
      envelopeFrom: 'docs@example.com',
      envelopeTo: 'ada@example.com',
      message: 'body',
    });

    expect(server.written[1]).toBe(`HELO docs.example.com${CRLF}`);
  });

  it('upgrades to TLS and re-reads the capabilities the server offers afterwards', async () => {
    // RFC 3207 §4: the extension list from before the upgrade is discarded, because a server
    // commonly advertises `AUTH` only once the channel is encrypted. A client that reused the
    // plaintext list is a client that decides not to authenticate.
    // Its own transcript rather than the one below, because a session with no credentials sends
    // no `AUTH` — and a transcript is positional, so reusing one written for the credentialed path
    // would answer `MAIL FROM` with the authentication reply.
    const server = await transcriptServer({
      upgradeAfter: 2,
      replies: [
        `220 smtp.example.com ESMTP${CRLF}`,
        `250-smtp.example.com${CRLF}250-8BITMIME${CRLF}250 STARTTLS${CRLF}`,
        `220 2.0.0 Ready to start TLS${CRLF}`,
        `250-smtp.example.com${CRLF}250-AUTH PLAIN LOGIN${CRLF}250 8BITMIME${CRLF}`,
        `250 Ok${CRLF}`,
        `250 Ok${CRLF}`,
        `354 Go ahead${CRLF}`,
        `250 Ok${CRLF}`,
        `221 Bye${CRLF}`,
      ],
    });

    await new SmtpSession(
      optionsFor(server.port, { security: 'STARTTLS', rejectUnauthorized: false }),
    ).send({ envelopeFrom: 'docs@example.com', envelopeTo: 'ada@example.com', message: 'b' });

    expect(server.written[0]).toBe(`EHLO docs.example.com${CRLF}`);
    expect(server.written[1]).toBe(`STARTTLS${CRLF}`);
    // The second EHLO arrived decrypted, which it only can if the handshake completed — the
    // handshake bytes themselves never reach this recording, because `TLSSocket` consumes them.
    expect(server.written[2]).toBe(`EHLO docs.example.com${CRLF}`);
  });

  it('authenticates with AUTH PLAIN, over a channel that is genuinely encrypted', async () => {
    const server = await transcriptServer(STARTTLS_THEN_AUTH_PLAIN);

    await new SmtpSession(
      optionsFor(server.port, {
        security: 'STARTTLS',
        username: 'relay',
        password: 'secret',
        rejectUnauthorized: false,
      }),
    ).send({ envelopeFrom: 'docs@example.com', envelopeTo: 'ada@example.com', message: 'b' });

    const auth = server.written[3] ?? '';
    expect(auth.startsWith('AUTH PLAIN ')).toBe(true);
    expect(Buffer.from(auth.slice('AUTH PLAIN '.length).trim(), 'base64').toString()).toBe(
      '\0relay\0secret',
    );
  });

  it('uses AUTH LOGIN when that is all the server offers', async () => {
    const server = await transcriptServer({
      upgradeAfter: 2,
      replies: [
        `220 smtp.example.com ESMTP${CRLF}`,
        `250-smtp.example.com${CRLF}250 STARTTLS${CRLF}`,
        `220 2.0.0 Ready to start TLS${CRLF}`,
        `250-smtp.example.com${CRLF}250 AUTH LOGIN${CRLF}`,
        `334 VXNlcm5hbWU6${CRLF}`,
        `334 UGFzc3dvcmQ6${CRLF}`,
        `235 Authentication successful${CRLF}`,
        `250 Ok${CRLF}`,
        `250 Ok${CRLF}`,
        `354 Go ahead${CRLF}`,
        `250 Ok${CRLF}`,
        `221 Bye${CRLF}`,
      ],
    });

    await new SmtpSession(
      optionsFor(server.port, {
        security: 'STARTTLS',
        username: 'relay',
        password: 'secret',
        rejectUnauthorized: false,
      }),
    ).send({ envelopeFrom: 'docs@example.com', envelopeTo: 'ada@example.com', message: 'b' });

    expect(server.written[3]).toBe(`AUTH LOGIN${CRLF}`);
    expect(Buffer.from((server.written[4] ?? '').trim(), 'base64').toString()).toBe('relay');
    expect(Buffer.from((server.written[5] ?? '').trim(), 'base64').toString()).toBe('secret');
  });

  it('refuses a relay whose certificate does not validate, by default', async () => {
    // The fixture certificate is self-signed, so a client that validates must refuse it — which
    // is what makes `MAIL_SMTP_REJECT_UNAUTHORIZED` a control rather than a comment.
    const server = await transcriptServer(STARTTLS_THEN_AUTH_PLAIN);

    const failure = await new SmtpSession(
      optionsFor(server.port, { security: 'STARTTLS', rejectUnauthorized: true }),
    )
      .send({ envelopeFrom: 'docs@example.com', envelopeTo: 'ada@example.com', message: 'b' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/self[- ]signed|unable to verify/i);
  });

  it('refuses to send credentials over an unencrypted connection', async () => {
    // Both mechanisms base64 the password, which is an encoding and not a protection. A client
    // that sent one anyway would make `MAIL_SMTP_SECURITY=NONE` mean "put the relay's password on
    // the wire", which is not something an operator should be able to configure by accident.
    const server = await transcriptServer({
      replies: [`220 smtp.example.com${CRLF}`, `250-smtp${CRLF}250 AUTH PLAIN${CRLF}`],
    });

    const failure = await new SmtpSession(
      optionsFor(server.port, { security: 'NONE', username: 'relay', password: 'secret' }),
    )
      .send({ envelopeFrom: 'docs@example.com', envelopeTo: 'ada@example.com', message: 'b' })
      .catch((error: unknown) => error);

    expect((failure as SmtpError).message).toContain('MAIL_SMTP_SECURITY');
    // And nothing resembling the password reached the socket.
    expect(server.written.join('')).not.toContain(
      Buffer.from('\0relay\0secret', 'utf8').toString('base64'),
    );
  });

  it('refuses when STARTTLS was asked for and the server does not offer it', async () => {
    // The STARTTLS stripping attack: a man in the middle removes the capability from the greeting,
    // and a client that quietly continues in the clear has a TLS setting that means nothing.
    const server = await transcriptServer({
      replies: [`220 smtp.example.com${CRLF}`, `250-smtp${CRLF}250 8BITMIME${CRLF}`],
    });

    const failure = await new SmtpSession(optionsFor(server.port, { security: 'STARTTLS' }))
      .send({ envelopeFrom: 'docs@example.com', envelopeTo: 'ada@example.com', message: 'b' })
      .catch((error: unknown) => error);

    expect((failure as SmtpError).message).toContain('STARTTLS');
    expect((failure as SmtpError).permanent).toBe(false);
  });

  it('treats a hang-up as transient, because it says nothing about the address', async () => {
    const server = await transcriptServer({
      replies: [`220 smtp.example.com${CRLF}`],
      hangUpAfter: 1,
    });

    const failure = await new SmtpSession(optionsFor(server.port))
      .send({ envelopeFrom: 'docs@example.com', envelopeTo: 'ada@example.com', message: 'b' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof SmtpError ? failure.permanent : true).toBe(false);
  });
});

describe('the adapter over that conversation', () => {
  const message = {
    idempotencyKey: 'notif-42:ada:EMAIL',
    recipient: { address: 'ada@example.com', displayName: 'Ada', locale: 'en' },
    subject: 'Approval required',
    bodyText: 'A document awaits your approval.',
    bodyHtml: '<p>A document awaits your approval.</p>',
    metadata: {},
  };

  function adapterFor(port: number): SmtpMailAdapter {
    return new SmtpMailAdapter({
      ...optionsFor(port),
      fromAddress: 'docs@example.com',
      fromName: 'Munaxa Docs',
    });
  }

  it('is the email channel, like the hosted driver beside it', () => {
    expect(adapterFor(0).channel).toBe(NotificationChannel.EMAIL);
  });

  it('accepts, and carries the relay’s queue identifier as evidence', async () => {
    const server = await transcriptServer(POSTFIX_ACCEPTS);

    const receipt = await adapterFor(server.port).send(message);

    expect(receipt).toMatchObject({
      accepted: true,
      providerMessageId: '4Wq3xy1Z2k',
      permanentFailure: false,
    });
  });

  it('sends a stable Message-ID, so a redelivery is one mail rather than two', async () => {
    const server = await transcriptServer(POSTFIX_ACCEPTS);

    await adapterFor(server.port).send(message);

    expect(server.written.join('')).toContain('Message-ID: <notif-42:ada:EMAIL@munaxa-docs>');
  });

  it('reports a rejected mailbox as a permanent failure, which suppresses the address', async () => {
    const server = await transcriptServer({
      replies: [
        `220 mail.example.com ESMTP${CRLF}`,
        `250 mail.example.com${CRLF}`,
        `250 Ok${CRLF}`,
        `550 5.1.1 User unknown${CRLF}`,
      ],
    });

    const receipt = await adapterFor(server.port).send(message);

    expect(receipt.accepted).toBe(false);
    expect(receipt.permanentFailure).toBe(true);
    expect(receipt.failureReason).toContain('550');
  });

  it('reports an unreachable relay as transient rather than as a bad address', async () => {
    // Nothing is listening on this port. A permanent classification here would suppress every
    // recipient in the tenant the first time the mail server was restarted.
    const receipt = await adapterFor(1).send(message);

    expect(receipt).toMatchObject({ accepted: false, permanentFailure: false });
  });
});
