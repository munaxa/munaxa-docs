/**
 * The one way this product makes an outbound HTTP request to an address a *tenant* chose.
 *
 * ## Why this exists at all, and why it exists now
 *
 * `17-security-architecture.md` §6 has had this row since Phase 0:
 *
 * > **SSRF** — No user-supplied URL is fetched by the server; the OIDC discovery endpoint is the
 * > only outbound URL, from a configured allow-list.
 *
 * Both halves were true for sixteen phases in the way an unfalsifiable statement is true: nothing
 * fetched a user-supplied URL because nothing fetched anything except the mail provider's fixed
 * endpoint, and the allow-list did not exist because nothing needed one. Phase 17 is where the
 * sentence starts describing a real risk. A webhook endpoint is a URL a tenant administrator
 * types; an OIDC discovery document is a URL a tenant administrator types; a SIEM collector is a
 * URL a tenant administrator types. Three of this phase's four capabilities are, structurally,
 * "post this to wherever the customer says".
 *
 * That makes tenant administrators — a role every customer has several of — able to aim the
 * server at anything the server can reach. On a cloud host that includes `169.254.169.254`, whose
 * instance-metadata service answers with credentials; inside a VPC it includes the database, the
 * Redis instance and every internal service that trusts the network. The classic exploit needs no
 * response body at all: a `POST` to an internal admin endpoint is an *action*, and a signed
 * webhook payload is attacker-chosen content delivered with the server's own network position.
 *
 * ## What the port refuses, and in which order
 *
 * The order matters, because each check closes a bypass for the one before it:
 *
 * 1. **Scheme.** `https` only, except where the deployment explicitly permits `http` for a
 *    development collector. `file:`, `gopher:` and `redis:` are what turn a fetcher into a
 *    file reader and a protocol-smuggling gadget.
 * 2. **Host, against the deployment's allow-list.** Not the tenant's — this is the one control in
 *    the phase that a tenant administrator cannot configure, because a boundary anybody inside it
 *    can edit is not a boundary. Empty allow-list means **nothing is reachable**, which is the
 *    correct default and is why every one of these capabilities is off until an operator turns it
 *    on for a named host.
 * 3. **Resolved address.** The host is resolved and every answer checked against the private,
 *    loopback, link-local and unique-local ranges *before* the socket is opened, and the
 *    connection is then made to the address that was checked. An allow-list of names alone is
 *    defeated by a DNS record pointing at `127.0.0.1`, and a check-then-connect is defeated by
 *    a record that changes between the two — the DNS-rebinding attack this whole port exists for.
 * 4. **Redirects.** Not followed, at all. A permitted host that answers `302` to
 *    `http://169.254.169.254/` would otherwise carry the request past every check above, and
 *    re-running the checks per hop is a control that is one forgotten branch from being absent.
 *    A receiver that needs a redirect can publish the destination.
 *
 * ## What it deliberately does not do
 *
 * It does not retry. Retrying is a property of the *thing being sent* — a webhook delivery has a
 * schedule an administrator can see and a dead-letter state, and a discovery fetch has neither and
 * should not — so the port performs one attempt and reports what happened. It does not parse: a
 * response is bytes and a status, and what they mean belongs to the caller.
 */
export const OUTBOUND_HTTP_PORT = Symbol('OutboundHttpPort');

export interface OutboundRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
}

export interface OutboundResponse {
  readonly status: number;
  /** Truncated by the adapter. A receiver returning a gigabyte must not become our memory. */
  readonly body: string;
  readonly durationMs: number;
}

/**
 * Why a request was not made, or did not succeed.
 *
 * `REFUSED` is separated from `NETWORK` because they mean opposite things to whoever is looking at
 * it: a refusal is *this deployment's policy* and is fixed by an operator adding a host to the
 * allow-list, while a network failure is the receiver's and is fixed by them. Collapsing them into
 * "delivery failed" would send an administrator to debug a firewall that is working correctly.
 */
export const OutboundFailureKind = {
  /** The URL did not pass scheme, allow-list or address checks. No socket was opened. */
  REFUSED: 'REFUSED',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
} as const;

export type OutboundFailureKindKey = (typeof OutboundFailureKind)[keyof typeof OutboundFailureKind];

export interface OutboundFailure {
  readonly kind: OutboundFailureKindKey;
  /** Safe to show an administrator and to store: never a response body, never a credential. */
  readonly reason: string;
  readonly durationMs: number;
}

export type OutboundResult =
  | { readonly ok: true; readonly response: OutboundResponse }
  | { readonly ok: false; readonly failure: OutboundFailure };

export interface OutboundHttpPort {
  /**
   * Whether this URL would be attempted, without attempting it.
   *
   * Exists so an administrator saving a webhook endpoint is told *at that moment* that the host is
   * not permitted, rather than saving happily and discovering it in a delivery log an hour later.
   * It answers the policy question only — scheme, allow-list, address — and makes no request, so
   * calling it is not itself an SSRF.
   */
  permits(url: string): Promise<{ readonly allowed: boolean; readonly reason: string | null }>;

  /** One attempt. Never throws for a refusal, a timeout or a network failure. */
  send(request: OutboundRequest): Promise<OutboundResult>;
}
