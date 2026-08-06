import { Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';

import { dataPayload } from './mime';

/**
 * One SMTP conversation: connect, greet, secure, authenticate, send, quit.
 *
 * ## The shape, and why it is small
 *
 * SMTP is a line protocol with a three-digit reply code on every turn. Everything difficult about
 * producing a *message* is in `mime.ts` and is pure; everything difficult about *transport
 * security* is `node:tls` and is Node's. What is left — and it is all that is here — is a fixed
 * command sequence and a comparison against the first digit of a reply.
 *
 * ## The two classifications that matter
 *
 * **4xx is transient and 5xx is permanent**, and RFC 5321 §4.2.1 is unambiguous about it: a 4xx
 * means "try again later, the same command may succeed", a 5xx means "this will never succeed as
 * sent". That distinction becomes `DeliveryReceipt.permanentFailure`, which is what decides whether
 * Phase 12's delivery path retries or suppresses the address — so getting it backwards would either
 * retry a nonexistent mailbox for ever or suppress a real one because a server was briefly busy.
 *
 * **A multi-line reply is one reply.** `250-STARTTLS` continues; `250 STARTTLS` ends. Reading the
 * first line as the answer is the classic hand-rolled-client defect, because it leaves the rest of
 * the reply in the buffer and every subsequent command reads the previous command's leftovers.
 *
 * ## What this deliberately does not implement
 *
 * Pipelining, CHUNKING/BDAT, DSN, SMTPUTF8 and connection reuse. Each is an optimisation or an
 * extension whose absence costs a round trip and never costs correctness, and a mail client is not
 * where this product spends its complexity budget. One message is one connection, which is also
 * what makes a failure attributable to the message that caused it.
 */

export type SmtpSecurity = 'NONE' | 'STARTTLS' | 'TLS';

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly security: SmtpSecurity;
  readonly username: string | null;
  readonly password: string | null;
  /** The name this client announces in `EHLO`. Some servers refuse an unresolvable one. */
  readonly clientName: string;
  readonly timeoutMs: number;
  /**
   * Whether the server's certificate must validate.
   *
   * False is for an on-premise relay with an internal certificate authority nobody has installed,
   * and it is a real configuration rather than a hypothetical one. It is a variable so that
   * choosing it is an act somebody performs and an operator can find, rather than a default.
   */
  readonly rejectUnauthorized: boolean;
}

export interface SmtpReply {
  readonly code: number;
  readonly text: string;
}

/**
 * A failure with the server's own reply attached.
 *
 * `permanent` is read straight off the reply class, and a transport failure — a refused connection,
 * a timeout, a certificate that will not validate — is deliberately **not** permanent: the mail
 * server being unreachable says nothing about the address.
 */
export class SmtpError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = 'SmtpError';
  }
}

type AnySocket = Socket | TLSSocket;

export class SmtpSession {
  private socket: AnySocket | null = null;
  private buffer = '';
  /** Resolvers waiting for the next complete reply, in order. */
  private pending: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void }[] = [];
  private failure: Error | null = null;
  private capabilities = new Set<string>();

  constructor(private readonly options: SmtpOptions) {}

  /**
   * Sends one message and closes.
   *
   * `QUIT` is best-effort after `DATA` has been accepted: the server has taken responsibility for
   * the message at the `250` above, so a connection that dies during the goodbye is a delivered
   * message and must not be reported as a failure — reporting one would cause a retry and a
   * duplicate.
   */
  async send(input: {
    readonly envelopeFrom: string;
    readonly envelopeTo: string;
    readonly message: string;
  }): Promise<SmtpReply> {
    await this.open();
    try {
      await this.expect(await this.readReply(), 2, 'greeting');
      await this.greet();
      if (this.options.security === 'STARTTLS') {
        await this.upgrade();
      }
      await this.authenticate();

      await this.expect(await this.command(`MAIL FROM:<${input.envelopeFrom}>`), 2, 'MAIL FROM');
      await this.expect(await this.command(`RCPT TO:<${input.envelopeTo}>`), 2, 'RCPT TO');
      await this.expect(await this.command('DATA'), 3, 'DATA');
      const accepted = await this.expect(
        await this.command(dataPayload(input.message), { raw: true }),
        2,
        'message body',
      );

      await this.command('QUIT').catch(() => undefined);
      return accepted;
    } finally {
      this.close();
    }
  }

  // --- Conversation ---------------------------------------------------------------------------

  /**
   * `EHLO`, falling back to `HELO`.
   *
   * The fallback is not politeness: a server that refuses `EHLO` is pre-1995 and advertises no
   * extensions, so `STARTTLS` and `AUTH` are both unavailable — and this must *fail* rather than
   * silently send a password or a message in the clear, which is what the checks below do.
   */
  private async greet(): Promise<void> {
    const reply = await this.command(`EHLO ${this.options.clientName}`);
    if (Math.floor(reply.code / 100) === 2) {
      this.capabilities = capabilitiesOf(reply.text);
      return;
    }
    await this.expect(await this.command(`HELO ${this.options.clientName}`), 2, 'HELO');
    this.capabilities = new Set();
  }

  private async upgrade(): Promise<void> {
    if (!this.capabilities.has('STARTTLS')) {
      // Refused rather than downgraded. A client that quietly continued in the clear when the
      // server did not offer TLS is a client whose "STARTTLS" setting means nothing — and this is
      // the exact shape of the STARTTLS stripping attack.
      throw new SmtpError('The server does not offer STARTTLS.', false);
    }
    await this.expect(await this.command('STARTTLS'), 2, 'STARTTLS');

    const plain = this.socket;
    if (plain === null) {
      throw new SmtpError('The connection closed during STARTTLS.', false);
    }
    // Every listener, not only `data`: the plain socket's `close` fires when TLS takes it over,
    // and a surviving handler would report the upgrade as the server hanging up.
    plain.removeAllListeners();
    this.socket = await this.wrapInTls(plain);
    this.listen(this.socket);
    // The extension list from before the upgrade is discarded, which RFC 3207 §4 requires: the
    // server may advertise different capabilities — commonly `AUTH` — only once the channel is
    // encrypted, and reusing the plaintext list is how a client decides not to authenticate.
    await this.greetAfterUpgrade();
  }

  private async greetAfterUpgrade(): Promise<void> {
    const reply = await this.expect(
      await this.command(`EHLO ${this.options.clientName}`),
      2,
      'EHLO after STARTTLS',
    );
    this.capabilities = capabilitiesOf(reply.text);
  }

  /**
   * `AUTH PLAIN`, or `AUTH LOGIN` where that is all the server offers.
   *
   * Both send the password base64-encoded, which is an encoding and not a protection — so both are
   * refused on an unencrypted channel. A deployment that genuinely wants that combination is
   * telling the adapter to put a credential on the wire in clear, and the right answer is to make
   * it configure `NONE` with no credentials rather than to let the two settings disagree quietly.
   */
  private async authenticate(): Promise<void> {
    const { username, password } = this.options;
    if (username === null || password === null) {
      return;
    }
    if (this.options.security === 'NONE') {
      throw new SmtpError(
        'SMTP credentials will not be sent over an unencrypted connection; set MAIL_SMTP_SECURITY.',
        false,
      );
    }
    if (this.capabilities.has('AUTH PLAIN') || this.capabilities.size === 0) {
      const token = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
      await this.expect(await this.command(`AUTH PLAIN ${token}`), 2, 'AUTH PLAIN');
      return;
    }
    if (this.capabilities.has('AUTH LOGIN')) {
      await this.expect(await this.command('AUTH LOGIN'), 3, 'AUTH LOGIN');
      await this.expect(
        await this.command(Buffer.from(username, 'utf8').toString('base64')),
        3,
        'AUTH LOGIN username',
      );
      await this.expect(
        await this.command(Buffer.from(password, 'utf8').toString('base64')),
        2,
        'AUTH LOGIN password',
      );
      return;
    }
    throw new SmtpError('The server offers no authentication mechanism this client speaks.', false);
  }

  // --- Transport ------------------------------------------------------------------------------

  private async open(): Promise<void> {
    this.socket =
      this.options.security === 'TLS' ? await this.connectTls() : await this.connectPlain();
    this.listen(this.socket);
  }

  private connectPlain(): Promise<Socket> {
    return new Promise<Socket>((resolve, reject) => {
      const socket = new Socket();
      socket.setTimeout(this.options.timeoutMs);
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new SmtpError('The mail server did not answer in time.', false));
      });
      socket.connect(this.options.port, this.options.host, () => {
        socket.removeListener('error', reject);
        resolve(socket);
      });
    });
  }

  private connectTls(): Promise<TLSSocket> {
    return new Promise<TLSSocket>((resolve, reject) => {
      const socket = tlsConnect(
        {
          host: this.options.host,
          port: this.options.port,
          // SNI, explicitly. Without it a shared relay answers with the wrong certificate and the
          // validation below fails for a reason that looks like a misconfiguration.
          servername: this.options.host,
          rejectUnauthorized: this.options.rejectUnauthorized,
        },
        () => {
          socket.removeListener('error', reject);
          resolve(socket);
        },
      );
      socket.setTimeout(this.options.timeoutMs);
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new SmtpError('The mail server did not answer in time.', false));
      });
    });
  }

  private wrapInTls(plain: AnySocket): Promise<TLSSocket> {
    return new Promise<TLSSocket>((resolve, reject) => {
      const secured = tlsConnect(
        {
          socket: plain,
          servername: this.options.host,
          rejectUnauthorized: this.options.rejectUnauthorized,
        },
        () => {
          secured.removeListener('error', reject);
          resolve(secured);
        },
      );
      secured.once('error', reject);
    });
  }

  private listen(socket: AnySocket): void {
    // Buffers rather than `setEncoding('utf8')`, because a socket in string mode cannot be handed
    // to `tls.connect({ socket })` — which is exactly what STARTTLS does to this one. Decoding per
    // chunk is safe here: SMTP replies are ASCII, so no multi-byte character can straddle two.
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      this.drain();
    });
    socket.on('error', (error: Error) => {
      this.fail(error);
    });
    socket.on('close', () => {
      this.fail(new SmtpError('The mail server closed the connection.', false));
    });
  }

  private close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.removeAllListeners();
      socket.destroy();
    }
  }

  private fail(error: Error): void {
    this.failure = error;
    const waiting = this.pending;
    this.pending = [];
    for (const entry of waiting) {
      entry.reject(error);
    }
  }

  // --- Framing --------------------------------------------------------------------------------

  private command(line: string, options: { raw?: boolean } = {}): Promise<SmtpReply> {
    const socket = this.socket;
    if (socket === null) {
      return Promise.reject(this.failure ?? new SmtpError('The connection is closed.', false));
    }
    socket.write(options.raw === true ? line : `${line}\r\n`);
    return this.readReply();
  }

  private readReply(): Promise<SmtpReply> {
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    return new Promise<SmtpReply>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.drain();
    });
  }

  /**
   * Hands out every complete reply the buffer now holds.
   *
   * A reply is complete when a line matches `NNN ` — a space in the fourth position — where `NNN-`
   * is a continuation. Both forms are kept in `text` so that the extension list survives into
   * `capabilitiesOf`.
   */
  private drain(): void {
    while (this.pending.length > 0) {
      const end = completeReplyLength(this.buffer);
      if (end === null) {
        return;
      }
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      const waiter = this.pending.shift();
      waiter?.resolve({ code: Number.parseInt(block.slice(0, 3), 10), text: block });
    }
  }

  private expect(reply: SmtpReply, expectedClass: number, step: string): Promise<SmtpReply> {
    if (Math.floor(reply.code / 100) === expectedClass) {
      return Promise.resolve(reply);
    }
    return Promise.reject(
      new SmtpError(
        `The mail server refused at ${step}: ${firstLineOf(reply.text)}`,
        // 5xx is permanent; 4xx and anything unexpected are not. Erring toward transient is the
        // safe direction: a retried message is a duplicate, and a wrongly permanent one is a
        // suppressed address and a person who stops being told about their approvals.
        Math.floor(reply.code / 100) === 5,
        reply.code,
      ),
    );
  }
}

/** How many characters of the buffer form one complete reply, or null if it is still arriving. */
function completeReplyLength(buffer: string): number | null {
  let offset = 0;
  for (;;) {
    const end = buffer.indexOf('\r\n', offset);
    if (end === -1) {
      return null;
    }
    const line = buffer.slice(offset, end);
    if (line.length >= 4 && line[3] === ' ') {
      return end + 2;
    }
    if (line.length === 3) {
      // A bare `250` with no separator. Not strictly legal, and emitted by enough small relays that
      // treating it as an unterminated reply would hang the session for the timeout.
      return end + 2;
    }
    offset = end + 2;
  }
}

/**
 * The extensions an `EHLO` reply advertised.
 *
 * `AUTH PLAIN LOGIN` becomes `AUTH PLAIN` and `AUTH LOGIN`, because what the caller asks is "does
 * it speak this mechanism" rather than "what does the AUTH line say".
 */
function capabilitiesOf(text: string): Set<string> {
  const capabilities = new Set<string>();
  for (const line of text.split('\r\n')) {
    const body = line.slice(4).trim().toUpperCase();
    if (body === '') {
      continue;
    }
    capabilities.add(body);
    const [keyword, ...rest] = body.split(/\s+/);
    if (keyword === 'AUTH') {
      capabilities.add('AUTH');
      for (const mechanism of rest) {
        capabilities.add(`AUTH ${mechanism}`);
      }
    } else if (keyword !== undefined) {
      capabilities.add(keyword);
    }
  }
  return capabilities;
}

function firstLineOf(text: string): string {
  return (text.split('\r\n')[0] ?? text).trim();
}
