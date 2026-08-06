import { randomBytes } from 'node:crypto';

/**
 * The message an SMTP session puts on the wire, as a pure function.
 *
 * ## Why this is a separate file from the session
 *
 * Phase 12 refused to build an SMTP adapter, and its reason was sound: *"an untested hand-rolled
 * SMTP client is a larger risk than an unbuilt one"*. Phase 18 builds it because on-premise
 * deployment is this phase's subject and `MAIL_DRIVER=SMTP` is the row 18 §3 has asked for since
 * Phase 0 — but the refusal is only answered if the "untested" half stops being true.
 *
 * Almost everything that is hard about SMTP is a string transformation, and all of it is here:
 * header folding, the encoded-word that lets an Arabic subject survive, the multipart boundary,
 * and dot-stuffing. None of it needs a socket, so all of it is a unit test against published
 * examples rather than an assertion about a mail server somebody has to run.
 *
 * What is left in `smtp-session.ts` is a command sequence and a reply-code comparison, and what is
 * left below *that* is `node:tls` — this file writes no cryptography and no framing that Node does
 * not already own. That is deliberately the same trade Phase 17 made for OIDC verification and
 * refused for XML-DSig: a format where the parsing is the hard part is one a hand-written
 * implementation gets subtly wrong while still accepting valid input, and SMTP is not one of those.
 *
 * @see RFC 5321 (SMTP), RFC 5322 (message format), RFC 2045/2047 (MIME, encoded words)
 */

const CRLF = '\r\n';

export interface MailAddress {
  readonly address: string;
  readonly displayName: string | null;
}

export interface MailContent {
  readonly from: MailAddress;
  readonly to: MailAddress;
  readonly subject: string;
  readonly text: string;
  readonly html: string | null;
  readonly messageId: string;
  readonly date: Date;
}

/**
 * Whether a string is safe to put in a header unencoded.
 *
 * RFC 5322 headers are US-ASCII, and everything else has to be encoded. The control characters are
 * excluded for a second reason that matters more: a newline in a display name or a subject is a
 * **header injection**, and this product's subjects are rendered from tenant-authored templates
 * with document titles substituted into them. `Subject: x\r\nBcc: attacker@example.com` is the
 * attack, and it is closed here by construction rather than by a filter somebody remembers.
 */
function isPlainAscii(value: string): boolean {
  return /^[\x20-\x7e]*$/.test(value);
}

/**
 * RFC 2047 `=?utf-8?B?…?=`, in bounded chunks.
 *
 * Base64 rather than quoted-printable: an Arabic subject is almost entirely non-ASCII, where
 * quoted-printable costs three bytes per character and base64 costs four per three. The 45-byte
 * chunk keeps each encoded word inside the 75-character limit the specification sets, and chunking
 * on **code points** rather than bytes is what stops a multi-byte character being split across two
 * words — which decodes to a replacement character in every client.
 */
function encodeWord(value: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const character of value) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 45) {
      words.push(`=?utf-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
      chunk = '';
    }
    chunk += character;
  }
  if (chunk !== '') {
    words.push(`=?utf-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
  }
  // Folded with CRLF + space, which is how a decoder is told the words are one field and also how
  // it knows not to insert a space between them.
  return words.join(`${CRLF} `);
}

/** A header value: as-is when it is plain ASCII, encoded when it is not. */
export function headerValue(value: string): string {
  return isPlainAscii(value) ? value : encodeWord(value);
}

/**
 * `Ada Lovelace <ada@example.com>`, or just the address.
 *
 * The address itself is never encoded — an SMTP envelope address is ASCII by definition and a
 * non-ASCII one needs SMTPUTF8, which this adapter does not advertise and does not claim. The
 * display name is, because it is a person's name and this product has Arabic-speaking customers.
 */
export function formatAddress(address: MailAddress): string {
  if (address.displayName === null || address.displayName === '') {
    return `<${address.address}>`;
  }
  const name = isPlainAscii(address.displayName)
    ? // Quoted, because a display name may legitimately contain a comma or a full stop, and both
      // are `specials` that end an unquoted atom.
      `"${address.displayName.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : encodeWord(address.displayName);
  return `${name} <${address.address}>`;
}

/**
 * The whole message: headers, then a `multipart/alternative` body when there is HTML.
 *
 * `multipart/alternative` rather than `multipart/mixed`, and the part order is load-bearing:
 * a client displays the **last** part it understands, so the plain text goes first and the HTML
 * second. Reversing them shows the plain text to every client that can render both.
 */
export function buildMessage(content: MailContent, boundary = newBoundary()): string {
  const headers = [
    `From: ${formatAddress(content.from)}`,
    `To: ${formatAddress(content.to)}`,
    `Subject: ${headerValue(content.subject)}`,
    `Date: ${rfc5322Date(content.date)}`,
    `Message-ID: <${content.messageId}>`,
    'MIME-Version: 1.0',
    // A notification is a machine-generated message about something that already happened; an
    // out-of-office reply to one is noise for the sender's mailbox and, at volume, a loop.
    'Auto-Submitted: auto-generated',
  ];

  if (content.html === null) {
    return [
      ...headers,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(content.text),
    ].join(CRLF);
  }

  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(content.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(content.html),
    `--${boundary}--`,
  ].join(CRLF);
}

/**
 * The body, base64 in 76-character lines.
 *
 * Base64 for every body, not only the Arabic ones, and that is a deliberate simplification with a
 * safety argument behind it: RFC 5321 caps a line at 998 octets and a rendered notification
 * contains document titles and comments of unknown length, so a raw 8-bit body is a message a
 * strict server can refuse for a reason nobody would reproduce. Encoding it removes the line-length
 * question, the 8-bit question and the trailing-whitespace question at once, and costs a third.
 */
function base64Body(body: string): string {
  const encoded = Buffer.from(body, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join(CRLF);
}

/**
 * `Wed, 06 Aug 2026 09:00:00 +0000`.
 *
 * Hand-formatted rather than taken from `toUTCString()`, which produces `GMT` — obsolete syntax in
 * RFC 5322 §4.3 that some spam filters score against.
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function rfc5322Date(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${DAYS[date.getUTCDay()] ?? 'Mon'}, ${pad(date.getUTCDate())} ` +
    `${MONTHS[date.getUTCMonth()] ?? 'Jan'} ${String(date.getUTCFullYear())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

export function newBoundary(): string {
  return `--=_munaxa_${randomBytes(12).toString('hex')}`;
}

/**
 * The `DATA` payload: CRLF line endings, leading dots doubled, terminated by `.` on its own line.
 *
 * **Dot-stuffing is the single most consequential five lines in this file.** `.` alone on a line
 * ends the message, so a body line that begins with one truncates the mail at that point — and
 * *the rest of it is interpreted as SMTP commands*. A base64 body cannot produce one, which is
 * most of why the bodies above are encoded; this runs anyway, because the headers are not encoded
 * and correctness here must not depend on an argument made two functions away.
 */
export function dataPayload(message: string): string {
  const normalised = message.replaceAll(/\r\n|\r|\n/g, CRLF);
  const stuffed = normalised
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
  return `${stuffed}${CRLF}.${CRLF}`;
}
