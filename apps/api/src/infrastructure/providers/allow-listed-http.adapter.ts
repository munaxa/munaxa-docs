import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { Inject, Injectable } from '@nestjs/common';

import { APP_CONFIG, type AppConfig } from '../../core/config';
import { LOGGER, type Logger } from '../../core/observability/logger';
import {
  type OutboundHttpPort,
  type OutboundRequest,
  type OutboundResult,
} from '../../ports/outbound-http.port';

/**
 * The only outbound HTTP this product performs to a tenant-chosen address — 17 §6's SSRF row,
 * built.
 *
 * The reasoning is all in `ports/outbound-http.port.ts`; what is here is the enforcement, and two
 * details of it are worth reading rather than skimming.
 *
 * **The connection goes to the address that was checked.** `fetch` given a hostname resolves it
 * again inside the stack, so a name that answered `93.184.216.34` to our check may answer
 * `127.0.0.1` to the socket — a DNS rebind, and the reason "resolve, validate, then fetch by name"
 * is a control that does not control anything. So the request is made against the **literal
 * address**, with the original hostname restored in the `Host` header and in TLS's SNI. That is
 * what closes the window rather than narrowing it.
 *
 * **A refusal names the rule, never the resolution.** An administrator whose endpoint is refused
 * is told "host not on this deployment's outbound allow-list"; they are not told which address it
 * resolved to, because that turns a refusal into a DNS oracle for the network the server sits in.
 */
@Injectable()
export class AllowListedHttpAdapter implements OutboundHttpPort {
  private readonly allowList: readonly string[];

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly resolve: (host: string) => Promise<readonly string[]> = defaultResolve,
  ) {
    this.allowList = config.outbound.allowList;
    this.allowInsecure = config.outbound.allowInsecure;
    this.maxResponseBytes = config.outbound.maxResponseBytes;
  }

  private readonly allowInsecure: boolean;
  private readonly maxResponseBytes: number;

  async permits(url: string): Promise<{ allowed: boolean; reason: string | null }> {
    const verdict = await this.check(url);
    return verdict.ok
      ? { allowed: true, reason: null }
      : { allowed: false, reason: verdict.reason };
  }

  async send(request: OutboundRequest): Promise<OutboundResult> {
    const startedAt = Date.now();
    const verdict = await this.check(request.url);
    if (!verdict.ok) {
      // No socket was opened, so this is policy rather than a failure of the receiver's. The
      // caller tells them apart by `kind` and reports them differently.
      return {
        ok: false,
        failure: { kind: 'REFUSED', reason: verdict.reason, durationMs: Date.now() - startedAt },
      };
    }

    const abort = new AbortController();
    const timer = setTimeout(() => {
      abort.abort();
    }, request.timeoutMs);

    try {
      const response = await this.fetchImpl(verdict.pinnedUrl, {
        method: request.method,
        headers: {
          ...request.headers,
          // The name the certificate is for and the vhost the receiver expects. Restored because
          // the URL above names an address rather than a host.
          Host: verdict.hostHeader,
        },
        ...(request.body !== undefined && { body: request.body }),
        signal: abort.signal,
        // Not followed, deliberately: a permitted host answering `302 http://169.254.169.254/`
        // would otherwise carry the request past every check above. `manual` surfaces the 3xx to
        // the caller as an ordinary unsuccessful status.
        redirect: 'manual',
      });

      return {
        ok: true,
        response: {
          status: response.status,
          body: (await response.text()).slice(0, this.maxResponseBytes),
          durationMs: Date.now() - startedAt,
        },
      };
    } catch (error) {
      const timedOut = abort.signal.aborted;
      this.logger.warn('An outbound request failed', {
        host: verdict.hostHeader,
        reason: timedOut ? 'timeout' : 'network',
      });
      return {
        ok: false,
        failure: {
          kind: timedOut ? 'TIMEOUT' : 'NETWORK',
          // The message, never the body: a receiver's error page may echo whatever we sent it.
          reason: timedOut
            ? `No response within ${request.timeoutMs}ms.`
            : errorMessage(error).slice(0, 200),
          durationMs: Date.now() - startedAt,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Scheme, then allow-list, then every resolved address. Each closes a bypass for the last. */
  private async check(
    raw: string,
  ): Promise<{ ok: true; pinnedUrl: string; hostHeader: string } | { ok: false; reason: string }> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: 'That is not a URL.' };
    }

    if (url.protocol !== 'https:' && !(this.allowInsecure && url.protocol === 'http:')) {
      return { ok: false, reason: 'Only https URLs are fetched.' };
    }
    // Credentials in the URL are refused rather than stripped: `https://user:pass@allowed.example`
    // is somebody putting a secret somewhere it will be logged, and silently removing it would
    // send a request they did not intend.
    if (url.username !== '' || url.password !== '') {
      return { ok: false, reason: 'A URL may not carry credentials.' };
    }

    const host = url.hostname.toLowerCase();
    if (!this.allowed(host)) {
      return {
        ok: false,
        reason: 'That host is not on this deployment’s outbound allow-list.',
      };
    }

    const addresses = isIP(host) ? [host] : await this.resolveSafely(host);
    if (addresses.length === 0) {
      return { ok: false, reason: 'That host does not resolve.' };
    }
    // **Every** answer, not the first: a name resolving to one public and one private address is
    // the rebinding attack pre-assembled, and picking whichever came back first is a coin toss.
    const forbidden = addresses.find((address) => !isPublicAddress(address));
    if (forbidden !== undefined) {
      return { ok: false, reason: 'That host resolves to an address that is not reachable.' };
    }

    const first = addresses[0] ?? '';
    const pinned = new URL(url.toString());
    pinned.hostname = first.includes(':') ? `[${first}]` : first;
    return { ok: true, pinnedUrl: pinned.toString(), hostHeader: url.host };
  }

  /**
   * Exact host, or a subdomain of an entry written with a leading dot.
   *
   * `.example.com` permits `hooks.example.com` and not `example.com.evil.net`; `example.com`
   * permits only itself. A bare suffix match would let the second through, which is the same
   * label-boundary mistake `domainMatches` refuses in the federation path.
   */
  private allowed(host: string): boolean {
    return this.allowList.some((entry) =>
      entry.startsWith('.') ? host.endsWith(entry) || host === entry.slice(1) : host === entry,
    );
  }

  private async resolveSafely(host: string): Promise<readonly string[]> {
    try {
      return await this.resolve(host);
    } catch {
      return [];
    }
  }
}

async function defaultResolve(host: string): Promise<readonly string[]> {
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

/**
 * Everything an internal service could be listening on, refused.
 *
 * Written out rather than pulled from a library because there is no library in this lockfile that
 * does it, and because the list is short, stable and worth reading in the file that depends on it.
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is unwrapped first — it is the same address wearing a
 * different notation, and a check that misses it is a check with a hole in exactly the shape of
 * the attack.
 */
export function isPublicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const value = mapped?.[1] ?? address;

  if (isIP(value) === 4) {
    const octets = value.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
      return false;
    }
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    if (a === 0 || a === 10 || a === 127) {
      return false;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return false;
    }
    if (a === 192 && b === 168) {
      return false;
    }
    // Carrier-grade NAT, link-local — `169.254.169.254` is the cloud metadata service and is the
    // single most valuable target an SSRF has.
    if (a === 100 && b >= 64 && b <= 127) {
      return false;
    }
    if (a === 169 && b === 254) {
      return false;
    }
    // Multicast, broadcast and the reserved top of the space.
    if (a >= 224) {
      return false;
    }
    return true;
  }

  if (isIP(value) === 6) {
    const lower = value.toLowerCase();
    if (lower === '::' || lower === '::1') {
      return false;
    }
    const head = lower.split(':')[0] ?? '';
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
    if (/^f[cd]/.test(head) || /^fe[89ab]/.test(head) || /^ff/.test(head)) {
      return false;
    }
    return true;
  }

  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}
