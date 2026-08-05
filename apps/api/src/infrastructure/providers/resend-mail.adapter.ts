import { Injectable } from '@nestjs/common';

import { type NotificationChannelKey, NotificationChannel } from '@edms/domain';

import type {
  DeliveryReceipt,
  NotificationMessage,
  NotificationPort,
} from '../../ports/notification.port';

/**
 * Email over a hosted provider's HTTP API — 18 §3's "a hosted provider for SaaS".
 *
 * ## Why this one, and why it is the only one
 *
 * `MAIL_DRIVER` has named `SMTP` and `RESEND` since Phase 0.5 and neither had an adapter. Phase
 * 12 built one, and the choice between them was decided by testability rather than by preference.
 *
 * An HTTP adapter can be exercised: `fetch` is injectable, the request it builds and every
 * response class it has to classify are assertable in a unit test, and CI — which runs with
 * `MAIL_DRIVER=NONE` and no outbound network — can run those tests. An SMTP adapter cannot be
 * exercised anywhere this repository builds: it needs a socket, a server, a TLS negotiation and a
 * multi-step protocol, and every one of those would be a hand-rolled implementation whose failure
 * modes nothing in CI could reach. "A provider you cannot test is a provider whose failure modes
 * you are guessing at" applies to both — but it applies to *all* of an untested SMTP client and
 * only to the wire of a tested HTTP one.
 *
 * `MAIL_DRIVER=SMTP` is therefore refused at boot, in `configuration.ts`, naming this decision.
 * That is the `OCR_DRIVER=HOSTED` precedent exactly: a value the schema accepts and no adapter
 * satisfies fails to start rather than failing at the first send. The on-premise deployments 18
 * §3 wants SMTP for are Phase 18's, and the report says so.
 *
 * ## Classification is the whole of the logic
 *
 * Everything else here is an HTTP request. What matters — the part `DeliveryService` and the
 * bounce counter depend on — is which failures are **permanent**. A permanent failure suppresses
 * an address after enough of them (§7), so calling a transient one permanent cuts a person off
 * from every notification in the product, and calling a permanent one transient burns the sending
 * domain's reputation on retries that cannot succeed.
 *
 * The rule is the HTTP status class, with one exception: 422 means the provider rejected the
 * *address*, and 429 means it rejected the *rate*, which sit either side of the 4xx line and
 * would be classified backwards by the class alone.
 */
@Injectable()
export class ResendMailAdapter implements NotificationPort {
  readonly channel: NotificationChannelKey = NotificationChannel.EMAIL;

  constructor(
    private readonly options: {
      readonly apiKey: string;
      readonly endpoint: string;
      readonly fromAddress: string;
      readonly fromName: string;
      readonly timeoutMs: number;
    },
    /**
     * Injected rather than reached for, so a test can assert what was sent without a network.
     * Defaulted to the global, so production wiring names nothing.
     */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: NotificationMessage): Promise<DeliveryReceipt> {
    // Bounded rather than left to the platform's default, which on Node is none: a provider that
    // accepts a connection and never answers would otherwise hold a delivery slot for ever.
    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
    }, this.options.timeoutMs);

    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          // The provider's own de-duplication, keyed on the same value the product keys on. A
          // retry after a timeout that in fact succeeded is the case this exists for.
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: `${this.options.fromName} <${this.options.fromAddress}>`,
          to: [message.recipient.address],
          subject: message.subject,
          text: message.bodyText,
          ...(message.bodyHtml === null ? {} : { html: message.bodyHtml }),
        }),
        signal: abort.signal,
      });

      if (response.ok) {
        return {
          accepted: true,
          providerMessageId: await readMessageId(response),
          failureReason: null,
          permanentFailure: false,
        };
      }

      return {
        accepted: false,
        providerMessageId: null,
        // The status and the provider's own words, truncated. Never the address: a failure
        // reason is stored on a row and read in a log, and neither is a place to accumulate a
        // mailing list.
        failureReason: `${String(response.status)} ${(await readText(response)).slice(0, 300)}`,
        permanentFailure: isPermanent(response.status),
      };
    } catch (error) {
      // A network failure, a DNS failure or the timeout above. All transient by definition: the
      // provider never gave a verdict, so there is nothing to conclude about the address.
      return {
        accepted: false,
        providerMessageId: null,
        failureReason: error instanceof Error ? error.message : 'unknown transport failure',
        permanentFailure: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Whether a status means "do not try this again".
 *
 * 4xx is the provider saying the request is wrong, and repeating a wrong request wastes the
 * sending domain's reputation. Two exceptions sit either side of that line and would be
 * classified backwards by the class alone:
 *
 * - **429** is 4xx and transient. It is the provider saying "not so fast", which is precisely a
 *   condition a retry resolves.
 * - **401 and 403** are 4xx and permanent for the *request*, but they say nothing about the
 *   address — a wrong API key would otherwise suppress every mailbox in the tenant, one bounce
 *   at a time. They are reported as transient so the misconfiguration shows up as a stuck queue,
 *   which is what it is, rather than as a directory full of dead addresses.
 */
export function isPermanent(status: number): boolean {
  if (status === 429 || status === 401 || status === 403) {
    return false;
  }
  return status >= 400 && status < 500;
}

async function readMessageId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'id' in body) {
      const { id } = body;
      return typeof id === 'string' ? id : null;
    }
  } catch {
    // A 2xx with an unreadable body is still an acceptance. The provider took it; we simply
    // cannot name what it called the message.
  }
  return null;
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
