/**
 * Which hops in front of a server may tell it who the client is.
 *
 * A server sees the address of whatever connected to it. Behind a reverse proxy, a load balancer or
 * the web tier's own server action, that is the proxy — so every client collapses onto one address,
 * and anything keyed on the address (the sign-in rate limit, above all) is keyed on the deployment
 * instead of on the person. The client's own address survives only in `X-Forwarded-For`, and that
 * header is written by whoever sent the request: a proxy appends what it saw, and a client can put
 * anything it likes there.
 *
 * So the header is read **only as far as the deployment has said it trusts the hops that wrote it**,
 * and the default is to trust none of them. The walk is the one `proxy-addr` (Express's resolver)
 * performs: start at the socket, move outward through the header from its right-hand end, and stop
 * at the first hop that is not trusted — that hop is the client. An address a client wrote for itself
 * is always to the left of the first untrusted hop, so it is never reached.
 *
 * Node-only (`node:net`), which is why it is its own entry point rather than part of the barrel.
 */
import { BlockList, isIP } from 'node:net';

/**
 * The request header the web tier's own HTTP server writes the resolved client address into.
 *
 * Written — or deleted — on every request by `apps/web/server.mjs` before Next.js sees it, so a value
 * a browser sent under this name never survives to be read.
 */
export const CLIENT_ADDRESS_HEADER = 'x-munaxa-client-address';

/**
 * Set in the web process by that same server, and only by it.
 *
 * The header above is trustworthy only when the process was started by the server that overwrites
 * it. Run under plain `next start` instead, the header would be whatever the browser sent — so the
 * reader asks for this first, and without it forwards nothing rather than forwarding a guess.
 */
export const CLIENT_ADDRESS_STAMPED_ENV = 'MUNAXA_CLIENT_ADDRESS_STAMPED';

/** What a deployment has said about the hops in front of it. */
export type ProxyTrust =
  /** Nothing in front is trusted: the socket's address is the client. The default. */
  | { readonly kind: 'NONE' }
  /**
   * Exactly this many hops sit in front, on every path. Only sound when no request can reach the
   * server by a shorter path — a client that connects directly would have its own header trusted.
   */
  | { readonly kind: 'HOPS'; readonly hops: number }
  /** Hops whose own address is in one of these ranges are trusted, wherever they sit. */
  | { readonly kind: 'ADDRESSES'; readonly entries: readonly string[] };

export class ProxyTrustError extends Error {
  override readonly name = 'ProxyTrustError';
}

/** The ranges behind the names `proxy-addr` accepts, so an operator's vocabulary carries over. */
const NAMED_RANGES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
});

/** More hops than any real chain has; a larger number is a typo for an address. */
const MAX_HOPS = 10;

/**
 * Reads a trust setting: empty or `false` for none, a whole number of hops, or a comma-separated
 * list of addresses, CIDR ranges and the names `loopback`, `linklocal` and `uniquelocal`.
 *
 * Throws on anything else — including `true` and `*`, which would trust every address and so let any
 * client choose its own. A deployment that means "the whole internet may speak for its clients" does
 * not exist, and one that typed it by mistake should fail to start rather than lose its rate limit.
 */
export function parseProxyTrust(raw: string | undefined): ProxyTrust {
  const value = (raw ?? '').trim();
  const lowered = value.toLowerCase();
  if (value === '' || lowered === 'false' || value === '0') {
    return { kind: 'NONE' };
  }
  if (lowered === 'true' || value === '*' || lowered === 'all') {
    throw new ProxyTrustError(
      `'${value}' would trust every address, which lets any client choose its own. ` +
        'Name the proxies: a hop count, or their addresses or CIDR ranges.',
    );
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > MAX_HOPS) {
      throw new ProxyTrustError(`${String(hops)} hops is more than any proxy chain has.`);
    }
    return { kind: 'HOPS', hops };
  }
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (!isNamedRange(entry) && rangeOf(entry) === null) {
      throw new ProxyTrustError(
        `'${entry}' is not an address, a CIDR range, or one of ${Object.keys(NAMED_RANGES).join(', ')}.`,
      );
    }
  }
  return { kind: 'ADDRESSES', entries };
}

/** Decides whether the hop at `hop` (0 is the socket) with this address may speak for the next. */
export type HopTrust = (address: string, hop: number) => boolean;

export function compileProxyTrust(trust: ProxyTrust): HopTrust {
  if (trust.kind === 'NONE') {
    return () => false;
  }
  if (trust.kind === 'HOPS') {
    const { hops } = trust;
    return (_address, hop) => hop < hops;
  }
  const list = new BlockList();
  for (const entry of trust.entries) {
    const ranges = isNamedRange(entry) ? (NAMED_RANGES[entry] ?? []) : [entry];
    for (const range of ranges) {
      const parsed = rangeOf(range);
      if (parsed !== null) {
        list.addSubnet(parsed.network, parsed.prefix, parsed.family);
      }
    }
  }
  return (address) => {
    const normalized = normalizeAddress(address);
    const family = isIP(normalized);
    if (family === 0) {
      return false;
    }
    return list.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
  };
}

/**
 * The client's address, given the socket's and the request's `X-Forwarded-For`.
 *
 * An entry that is not an address ends the walk at the hop that reported it: a trusted proxy that
 * passed on garbage has told us nothing about the client, and the proxy itself is the most specific
 * thing we know.
 */
export function clientAddressOf(
  socketAddress: string | undefined,
  forwardedFor: string | readonly string[] | undefined,
  trusted: HopTrust,
): string | undefined {
  if (socketAddress === undefined || socketAddress.length === 0) {
    return undefined;
  }
  const chain = [normalizeAddress(socketAddress), ...forwardedChain(forwardedFor).reverse()];
  for (let hop = 0; hop < chain.length - 1; hop++) {
    const address = chain[hop] ?? '';
    if (!trusted(address, hop)) {
      return address;
    }
    const next = chain[hop + 1] ?? '';
    if (isIP(next) === 0) {
      return address;
    }
  }
  return chain[chain.length - 1];
}

/** `::ffff:10.0.0.1` is `10.0.0.1`: a dual-stack socket must not be a second identity. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}

function forwardedChain(header: string | readonly string[] | undefined): string[] {
  if (header === undefined) {
    return [];
  }
  const joined = typeof header === 'string' ? header : header.join(',');
  return joined
    .split(',')
    .map((entry) => normalizeAddress(entry))
    .filter((entry) => entry.length > 0);
}

function isNamedRange(entry: string): boolean {
  return Object.prototype.hasOwnProperty.call(NAMED_RANGES, entry);
}

function rangeOf(
  entry: string,
): { network: string; prefix: number; family: 'ipv4' | 'ipv6' } | null {
  const [network = '', prefixText, ...rest] = entry.split('/');
  if (rest.length > 0) {
    return null;
  }
  const normalized = normalizeAddress(network);
  const family = isIP(normalized);
  if (family === 0) {
    return null;
  }
  const max = family === 4 ? 32 : 128;
  if (prefixText === undefined) {
    return { network: normalized, prefix: max, family: family === 4 ? 'ipv4' : 'ipv6' };
  }
  if (!/^\d{1,3}$/.test(prefixText)) {
    return null;
  }
  const prefix = Number(prefixText);
  if (prefix > max) {
    return null;
  }
  return { network: normalized, prefix, family: family === 4 ? 'ipv4' : 'ipv6' };
}
