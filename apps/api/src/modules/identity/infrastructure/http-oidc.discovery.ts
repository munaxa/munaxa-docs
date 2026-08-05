import { Inject, Injectable } from '@nestjs/common';

import { LOGGER, type Logger } from '../../../core/observability/logger';
import { CACHE_PORT, type CachePort } from '../../../ports/cache.port';
import { OUTBOUND_HTTP_PORT, type OutboundHttpPort } from '../../../ports/outbound-http.port';
import type {
  DiscoveryDocument,
  IdentityProviderCredential,
  IdentityProviderRecord,
  OidcDiscovery,
} from '../application/federation.ports';

/**
 * How long a provider's metadata and keys are cached.
 *
 * An hour. A discovery document changes when a provider reorganises its endpoints, which is
 * approximately never, and a JWKS changes when it rotates a signing key, which is monthly at most
 * — and a rotation is handled by the *absence* of a matching key rather than by the TTL: a token
 * signed with a key we do not hold fails verification, and the next hour's fetch picks it up. The
 * alternative, re-fetching on a miss, would let anybody force two outbound requests by presenting
 * a token with an unknown `kid`.
 */
const METADATA_TTL_SECONDS = 3_600;

/** Bounded so a provider publishing a large JWKS cannot make us hold it. */
const MAX_KEYS = 20;

/**
 * The OIDC discovery and token exchange, over the allow-listed outbound port.
 *
 * **This is the URL 17 §6 has been about since Phase 0** — *"the OIDC discovery endpoint is the
 * only outbound URL, from a configured allow-list"* — and until this phase there was neither a
 * discovery endpoint nor an allow-list. Both exist now, and every request here goes through
 * `OUTBOUND_HTTP_PORT`, which is the only thing in the product that may reach a tenant-chosen
 * address at all.
 *
 * The port is not optional here and cannot be worked around: there is no `fetch` in this file.
 *
 * ## Cached, because a provider's availability must not become ours
 *
 * Two round trips in front of every federated sign-in would mean a provider having a slow morning
 * makes *our* sign-in slow, and a provider having an outage makes ours look like one. The metadata
 * is cached for an hour under the provider's identifier, which is stable across its edits — and
 * deliberately not under the discovery URL, so changing that URL invalidates nothing and the next
 * hour picks it up. That is a real limit and it is stated: an administrator repointing a provider
 * waits up to an hour, which is the right trade against a per-sign-in fetch.
 */
@Injectable()
export class HttpOidcDiscovery implements OidcDiscovery {
  constructor(
    @Inject(OUTBOUND_HTTP_PORT) private readonly http: OutboundHttpPort,
    @Inject(CACHE_PORT) private readonly cache: CachePort,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async resolve(
    provider: IdentityProviderRecord,
  ): Promise<{ document: DiscoveryDocument; keys: readonly unknown[] } | null> {
    const key = `oidc:metadata:${provider.id}`;
    const cached = await this.cache.get<{ document: DiscoveryDocument; keys: unknown[] }>(key);
    if (cached) {
      return cached;
    }

    const discovered = await this.fetchJson(provider.discoveryUrl);
    if (!discovered) {
      return null;
    }
    const document = toDocument(discovered);
    if (!document) {
      this.logger.warn('A discovery document was missing required endpoints', {
        providerId: provider.id,
      });
      return null;
    }
    // The issuer the *document* claims must be the one configured. A provider whose discovery
    // document names a different issuer is either misconfigured or is somebody else's document
    // being served from a permitted host, and both are refusals rather than warnings — the issuer
    // is one of the four checks a token is verified against, and taking it from the document
    // rather than from configuration would make that check circular.
    if (document.issuer !== provider.issuer) {
      this.logger.warn('A discovery document claimed a different issuer', {
        providerId: provider.id,
      });
      return null;
    }

    const jwks = await this.fetchJson(document.jwksUri);
    const rawKeys = jwks?.['keys'];
    if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
      return null;
    }
    const keys = rawKeys.slice(0, MAX_KEYS);

    const resolved = { document, keys };
    await this.cache.set(key, resolved, METADATA_TTL_SECONDS);
    return resolved;
  }

  async exchange(
    provider: IdentityProviderCredential,
    document: DiscoveryDocument,
    code: string,
    redirectUri: string,
  ): Promise<{ idToken: string } | null> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
    }).toString();

    const result = await this.http.send({
      url: document.tokenEndpoint,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      timeoutMs: 10_000,
    });

    if (!result.ok || result.response.status < 200 || result.response.status >= 300) {
      // The provider's response body is deliberately **not** logged: a failed token exchange
      // frequently echoes the code, and sometimes the client id, into its error description.
      this.logger.warn('A token exchange did not succeed', {
        providerId: provider.id,
        status: result.ok ? result.response.status : null,
      });
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(result.response.body);
      const idToken = (parsed as Record<string, unknown> | null)?.['id_token'];
      // Only the ID token is read. The access and refresh tokens a provider returns are *its*
      // credentials for *its* APIs — this product has no use for them and storing them would make
      // it a holder of somebody's Microsoft Graph access, which is a very different security
      // posture from the one it has.
      return typeof idToken === 'string' && idToken.length > 0 ? { idToken } : null;
    } catch {
      return null;
    }
  }

  private async fetchJson(url: string): Promise<Record<string, unknown> | null> {
    const result = await this.http.send({ url, method: 'GET', timeoutMs: 10_000 });
    if (!result.ok || result.response.status !== 200) {
      this.logger.warn('An OIDC metadata fetch did not succeed', {
        // The failure kind, so a refusal by the allow-list is distinguishable from a provider
        // outage. Never the URL — a customer's internal hostname is not for a log line.
        reason: result.ok ? `status ${result.response.status}` : result.failure.kind,
      });
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(result.response.body);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

function toDocument(raw: Record<string, unknown>): DiscoveryDocument | null {
  const issuer = asString(raw['issuer']);
  const authorizationEndpoint = asString(raw['authorization_endpoint']);
  const tokenEndpoint = asString(raw['token_endpoint']);
  const jwksUri = asString(raw['jwks_uri']);
  if (!issuer || !authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    return null;
  }
  return { issuer, authorizationEndpoint, tokenEndpoint, jwksUri };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
