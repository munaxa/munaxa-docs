import { Injectable } from '@nestjs/common';

import { type NotificationChannelKey, NotificationChannel } from '@edms/domain';

import type {
  DeliveryReceipt,
  NotificationMessage,
  NotificationPort,
} from '../../../ports/notification.port';
import { buildMessage } from './mime';
import { SmtpError, SmtpSession, type SmtpOptions } from './smtp-session';

/**
 * Email over SMTP — 18 §3's on-premise row, and Phase 12's owed one.
 *
 * ## Why Phase 18 built what Phase 12 refused
 *
 * Phase 12's reason was testability, stated plainly and correctly: *"an SMTP adapter cannot be
 * exercised anywhere this repository builds… every one of those would be a hand-rolled
 * implementation whose failure modes nothing in CI could reach"*. That is an argument about
 * *evidence*, not about SMTP, and it is answered by producing the evidence rather than by
 * disagreeing with it.
 *
 * The work is split so that almost none of it needs a mail server. `mime.ts` is a string
 * transformation — encoded words, folding, boundaries, dot-stuffing — tested against the
 * specifications' own examples. `smtp-session.ts` is a command sequence and a reply-code
 * comparison, tested against **transcripts of real servers**: a socket the suite drives, replaying
 * what Postfix, Exchange Online and a small relay actually answer, asserting the bytes this client
 * writes. Transport security is `node:tls` and is not written here at all.
 *
 * That is deliberately the same trade Phase 17 made for OIDC verification and refused for XML-DSig,
 * and the distinction it turns on is unchanged: SMTP is a line protocol where a reader can check
 * every branch by eye, and CBOR and XML canonicalisation are formats where the parsing is the hard
 * part and a subtly wrong implementation still accepts valid input.
 *
 * **What CI does not do is talk to a real mail server**, and the report says so rather than
 * implying otherwise. The transcripts are fixtures; a fixture is a claim about how a server
 * behaves, and a wrong fixture is a wrong test. What bounds that risk is that the transcripts
 * cover the branch structure rather than the vocabulary — a 2xx, a 4xx, a 5xx, a multi-line
 * greeting, a server without STARTTLS — and every one of those is defined by RFC 5321 rather than
 * by a vendor.
 *
 * ## Classification is the whole of the logic, exactly as it is for the hosted driver
 *
 * `permanentFailure` decides whether Phase 12's delivery path retries or suppresses the address,
 * so a transient failure called permanent cuts somebody off from every notification in the
 * product, and a permanent one called transient burns the sending domain on retries that cannot
 * succeed. Over SMTP the rule is simpler than it is over HTTP and is in the specification rather
 * than in a vendor's documentation: **5xx is permanent, 4xx is not, and a transport failure is
 * not** — a mail server being unreachable says nothing about the address.
 */
@Injectable()
export class SmtpMailAdapter implements NotificationPort {
  readonly channel: NotificationChannelKey = NotificationChannel.EMAIL;

  constructor(
    private readonly options: SmtpOptions & {
      readonly fromAddress: string;
      readonly fromName: string;
    },
    /**
     * Injected so a suite can drive a session against a socket it controls, and defaulted so
     * production wiring names nothing — the `ResendMailAdapter` precedent, where `fetch` is the
     * same seam.
     */
    private readonly openSession: (options: SmtpOptions) => SmtpSession = (smtp) =>
      new SmtpSession(smtp),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send(message: NotificationMessage): Promise<DeliveryReceipt> {
    const body = buildMessage({
      from: { address: this.options.fromAddress, displayName: this.options.fromName },
      to: {
        address: message.recipient.address,
        displayName: message.recipient.displayName,
      },
      subject: message.subject,
      text: message.bodyText,
      html: message.bodyHtml,
      // The idempotency key, which is deterministic per (message, recipient, channel). That makes
      // the `Message-ID` stable across a redelivery, so a server or a mailbox that de-duplicates
      // on it collapses an at-least-once retry into one mail rather than two.
      messageId: `${message.idempotencyKey}@munaxa-docs`,
      date: this.now(),
    });

    try {
      const reply = await this.openSession(this.options).send({
        // The envelope sender, which is where a bounce goes and is deliberately the same address
        // the header names: a mismatch is what SPF alignment fails on, and a deployment whose
        // notifications land in spam has a product nobody trusts.
        envelopeFrom: this.options.fromAddress,
        envelopeTo: message.recipient.address,
        message: body,
      });
      return {
        accepted: true,
        // Servers commonly answer `250 2.0.0 Ok: queued as 4Wq3…`, and that identifier is what an
        // operator greps for in the relay's log. It is taken verbatim when there is one and left
        // null when there is not, rather than invented — `providerMessageId` is evidence.
        providerMessageId: queuedIdOf(reply.text),
        failureReason: null,
        permanentFailure: false,
      };
    } catch (error) {
      const permanent = error instanceof SmtpError && error.permanent;
      return {
        accepted: false,
        providerMessageId: null,
        // The server's own first line, truncated. It is the only useful thing an operator has and
        // it contains no credential — the password is never echoed by any reply in the sequence.
        failureReason: (error instanceof Error ? error.message : 'unknown').slice(0, 500),
        permanentFailure: permanent,
      };
    }
  }
}

/** `250 2.0.0 Ok: queued as 4Wq3xy` → `4Wq3xy`. Null when the server said nothing like that. */
export function queuedIdOf(text: string): string | null {
  const match = /queued as ([^\s;]+)/i.exec(text);
  return match?.[1] ?? null;
}
