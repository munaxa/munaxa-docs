import { describe, expect, it } from 'vitest';

import { buildMessage, dataPayload, formatAddress, headerValue, rfc5322Date } from './mime';

const CRLF = '\r\n';

describe('header encoding', () => {
  it('leaves plain ASCII alone, because encoding it would only make it unreadable', () => {
    expect(headerValue('Document DOC-2026-0041 approved')).toBe('Document DOC-2026-0041 approved');
  });

  it('encodes an Arabic subject, which is half this product’s notifications', () => {
    const encoded = headerValue('تمت الموافقة على المستند');

    expect(encoded.startsWith('=?utf-8?B?')).toBe(true);
    expect(decodeWords(encoded)).toBe('تمت الموافقة على المستند');
  });

  it('never splits a multi-byte character across two encoded words', () => {
    // The defect this prevents decodes to a replacement character in every mail client, and only
    // for subjects long enough to need a second word — so it ships and is found by a customer.
    const long = 'المستند '.repeat(40);

    expect(decodeWords(headerValue(long))).toBe(long);
  });

  it('keeps every encoded word inside the 75-character limit', () => {
    for (const word of headerValue('تمت الموافقة على المستند رقم واحد اثنان ثلاثة').split(
      `${CRLF} `,
    )) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it('closes header injection: a newline in a subject cannot add a header', () => {
    // The attack. This product's subjects are rendered from tenant templates with document titles
    // substituted in, and a title is user input.
    const injected = headerValue('Approved\r\nBcc: attacker@example.com');

    expect(injected).not.toContain(`${CRLF}Bcc:`);
    expect(decodeWords(injected)).toBe('Approved\r\nBcc: attacker@example.com');
  });
});

describe('addresses', () => {
  it('quotes a display name, because a comma in one would otherwise end the address', () => {
    expect(formatAddress({ address: 'ada@example.com', displayName: 'Lovelace, Ada' })).toBe(
      '"Lovelace, Ada" <ada@example.com>',
    );
  });

  it('encodes an Arabic display name and leaves the address as ASCII', () => {
    const formatted = formatAddress({ address: 'ada@example.com', displayName: 'عايدة' });

    expect(formatted.endsWith('<ada@example.com>')).toBe(true);
    expect(decodeWords(formatted.split(' <')[0] ?? '')).toBe('عايدة');
  });

  it('omits the angle-bracket name entirely when there is none', () => {
    expect(formatAddress({ address: 'ada@example.com', displayName: null })).toBe(
      '<ada@example.com>',
    );
  });
});

describe('the message', () => {
  const base = {
    from: { address: 'docs@example.com', displayName: 'Munaxa Docs' },
    to: { address: 'ada@example.com', displayName: 'Ada' },
    subject: 'Approval required',
    text: 'A document awaits your approval.',
    html: '<p>A document awaits your approval.</p>',
    messageId: 'abc-123@munaxa-docs',
    date: new Date('2026-08-06T09:00:00.000Z'),
  };

  it('puts the plain text before the HTML, because a client shows the last part it understands', () => {
    const message = buildMessage(base, 'BOUNDARY');

    expect(message.indexOf('text/plain')).toBeLessThan(message.indexOf('text/html'));
  });

  it('closes the multipart with the terminating boundary', () => {
    expect(buildMessage(base, 'BOUNDARY')).toContain(`${CRLF}--BOUNDARY--`);
  });

  it('sends a single part when there is no HTML', () => {
    const message = buildMessage({ ...base, html: null }, 'BOUNDARY');

    expect(message).not.toContain('multipart/alternative');
    expect(message).toContain('Content-Type: text/plain; charset=utf-8');
  });

  it('encodes the body, so no line can exceed the protocol’s limit', () => {
    const message = buildMessage({ ...base, text: 'x'.repeat(5_000), html: null }, 'B');

    for (const line of message.split(CRLF)) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  it('round-trips an Arabic body through the transfer encoding', () => {
    const body = 'المستند بانتظار موافقتك.';
    const message = buildMessage({ ...base, text: body, html: null }, 'B');
    const encoded = message.split(`${CRLF}${CRLF}`)[1] ?? '';

    expect(Buffer.from(encoded.replaceAll(CRLF, ''), 'base64').toString('utf8')).toBe(body);
  });

  it('dates in RFC 5322’s numeric form rather than the obsolete GMT one', () => {
    expect(rfc5322Date(base.date)).toBe('Thu, 06 Aug 2026 09:00:00 +0000');
  });

  it('marks itself auto-generated, so nothing replies with an out-of-office', () => {
    expect(buildMessage(base, 'B')).toContain('Auto-Submitted: auto-generated');
  });
});

describe('the DATA payload', () => {
  it('doubles a leading dot — the truncation that turns a body into commands', () => {
    // A single `.` on its own line ends the message, and everything after it is read as SMTP.
    const payload = dataPayload(`Subject: x${CRLF}${CRLF}.hidden${CRLF}. ${CRLF}visible`);

    expect(payload).toContain(`${CRLF}..hidden${CRLF}`);
    expect(payload).toContain(`${CRLF}.. ${CRLF}`);
  });

  it('terminates with a bare dot on its own line', () => {
    expect(dataPayload('body').endsWith(`${CRLF}.${CRLF}`)).toBe(true);
  });

  it('normalises every line ending to CRLF', () => {
    const payload = dataPayload('one\ntwo\rthree\r\nfour');

    expect(payload).toBe(`one${CRLF}two${CRLF}three${CRLF}four${CRLF}.${CRLF}`);
  });
});

/** Decodes the `=?utf-8?B?…?=` words a header may be folded into. */
function decodeWords(header: string): string {
  return header
    .split(`${CRLF} `)
    .map((word) => {
      const match = /^=\?utf-8\?B\?(.*)\?=$/.exec(word);
      return match === null ? word : Buffer.from(match[1] ?? '', 'base64').toString('utf8');
    })
    .join('');
}
