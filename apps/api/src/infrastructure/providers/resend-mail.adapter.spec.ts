import { describe, expect, it } from 'vitest';

import { ResendMailAdapter, isPermanent } from './resend-mail.adapter';

/**
 * The mail adapter, and the one part of it that matters.
 *
 * Sending an HTTP request is not what these assert. **Classification** is: which failures are
 * permanent, because a permanent one suppresses an address after enough of them (18 §7) and a
 * transient one is retried. Calling a transient failure permanent cuts a person off from every
 * notification in the product; calling a permanent one transient burns the sending domain's
 * reputation on retries that cannot succeed.
 *
 * This is also the reason the hosted provider was built and SMTP was not: `fetch` is a parameter,
 * so every response class the adapter has to classify is reachable from a test, in CI, with no
 * network. A hand-rolled SMTP client's failure modes would have been reachable from nowhere.
 */

const OPTIONS = {
  apiKey: 'test-key',
  endpoint: 'https://mail.example.test/emails',
  fromAddress: 'docs@example.test',
  fromName: 'Munaxa Docs',
  timeoutMs: 1_000,
};

const MESSAGE = {
  idempotencyKey: 'message-1',
  recipient: { address: 'ada@example.test', displayName: null, locale: 'en' },
  subject: 'Your approval is needed',
  bodyText: 'Open it here.',
  bodyHtml: '<p>Open it here.</p>',
  metadata: { typeKey: 'workflow.task-assigned' },
};

function respondWith(status: number, body: unknown): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );
}

/** A transport that never answers. */
function failWith(reason: string): typeof fetch {
  return () => Promise.reject(new Error(reason));
}

/** What a captured request carried, read back as the strings it was serialised from. */
function sentBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  return typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function sentHeaders(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

/** Captures the request instead of making one. */
function capture(into: { request?: RequestInit }): typeof fetch {
  return ((_url: string, init: RequestInit) => {
    into.request = init;
    return Promise.resolve(new Response(JSON.stringify({ id: 'x' }), { status: 200 }));
  }) as unknown as typeof fetch;
}

describe('classifying a provider response', () => {
  it('treats a 4xx as permanent, because repeating a wrong request wastes the domain', () => {
    expect(isPermanent(400)).toBe(true);
    expect(isPermanent(422)).toBe(true);
  });

  it('treats a 5xx as transient, because the provider never gave a verdict on the address', () => {
    expect(isPermanent(500)).toBe(false);
    expect(isPermanent(503)).toBe(false);
  });

  it('treats rate limiting as transient, despite being 4xx', () => {
    // "Not so fast" is precisely a condition a retry resolves.
    expect(isPermanent(429)).toBe(false);
  });

  it('treats an authentication failure as transient, so a wrong key suppresses nobody', () => {
    // 401 and 403 are permanent for the *request* and say nothing about the address. Reported as
    // transient so a misconfiguration shows up as a stuck queue — which is what it is — rather
    // than as a directory full of addresses suppressed one bounce at a time.
    expect(isPermanent(401)).toBe(false);
    expect(isPermanent(403)).toBe(false);
  });
});

describe('sending', () => {
  it('accepts a 2xx and carries the provider’s own message id', async () => {
    const adapter = new ResendMailAdapter(OPTIONS, respondWith(200, { id: 'provider-42' }));
    const receipt = await adapter.send(MESSAGE);

    expect(receipt).toEqual({
      accepted: true,
      providerMessageId: 'provider-42',
      failureReason: null,
      permanentFailure: false,
    });
  });

  it('still accepts a 2xx whose body cannot be read', async () => {
    const adapter = new ResendMailAdapter(OPTIONS, respondWith(202, 'not json'));
    const receipt = await adapter.send(MESSAGE);

    // The provider took it; we simply cannot name what it called the message.
    expect(receipt.accepted).toBe(true);
    expect(receipt.providerMessageId).toBeNull();
  });

  it('reports a rejection with the status and the provider’s words, and never the address', async () => {
    const adapter = new ResendMailAdapter(
      OPTIONS,
      respondWith(422, { message: 'Invalid `to` field' }),
    );
    const receipt = await adapter.send(MESSAGE);

    expect(receipt.accepted).toBe(false);
    expect(receipt.permanentFailure).toBe(true);
    expect(receipt.failureReason).toContain('422');
    expect(receipt.failureReason).not.toContain('ada@example.test');
  });

  it('treats a transport failure as transient, because no verdict was given', async () => {
    const adapter = new ResendMailAdapter(OPTIONS, failWith('getaddrinfo ENOTFOUND'));
    const receipt = await adapter.send(MESSAGE);

    expect(receipt.accepted).toBe(false);
    expect(receipt.permanentFailure).toBe(false);
    expect(receipt.failureReason).toContain('ENOTFOUND');
  });

  it('sends the idempotency key the product keys on, so a retried timeout cannot duplicate', async () => {
    const seen: { request?: RequestInit } = {};
    await new ResendMailAdapter(OPTIONS, capture(seen)).send(MESSAGE);

    expect(sentHeaders(seen.request)['idempotency-key']).toBe('message-1');
    expect(sentBody(seen.request)).toMatchObject({
      from: 'Munaxa Docs <docs@example.test>',
      to: ['ada@example.test'],
      subject: 'Your approval is needed',
      html: '<p>Open it here.</p>',
    });
  });

  it('omits the HTML part entirely when a channel has none', async () => {
    const seen: { request?: RequestInit } = {};
    await new ResendMailAdapter(OPTIONS, capture(seen)).send({ ...MESSAGE, bodyHtml: null });

    // Absent rather than null: a provider that receives `"html": null` may reject the request,
    // and there is nothing to say.
    expect(Object.keys(sentBody(seen.request))).not.toContain('html');
  });
});
