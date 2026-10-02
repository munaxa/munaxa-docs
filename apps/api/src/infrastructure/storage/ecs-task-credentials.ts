import { StorageUnavailableError } from '../../core/errors/application-errors';
import type { SigningCredentials } from './sigv4';

/**
 * The ECS task role's credentials, read from the one endpoint ECS gives a task for them.
 *
 * Under `STORAGE_CREDENTIALS_SOURCE=ECS_TASK_ROLE` the S3 adapter signs with these instead of a
 * long-lived key pair. They are temporary — an access key, a secret and a session token, with an
 * expiry — and ECS rotates them, so they are fetched on first use, cached, and fetched again before
 * they run out.
 *
 * **Exactly one endpoint, and nothing that resembles a credential-provider chain.** `sigv4.ts`
 * explains why this product never took the SDK: a provider chain that will read an instance metadata
 * endpoint nobody asked it to. This reads `http://169.254.170.2` plus the path ECS puts in
 * `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, and refuses any value that would resolve anywhere else.
 * It is deliberately not the outbound HTTP adapter, which blocks link-local addresses for good
 * reason; this is the single place the product is meant to talk to one.
 *
 * Nothing it handles is ever logged or put in an error message: not the keys, not the token, not
 * the endpoint's response body.
 */

/** The address ECS serves task-role credentials on. Fixed by ECS; not configuration. */
export const ECS_CREDENTIALS_HOST = '169.254.170.2';

/**
 * How long before expiry a credential stops being handed out, on top of what the caller needs.
 *
 * The caller's own requirement already covers the lifetime of a presigned URL; this covers the time
 * between signing and the store checking the signature, and clock skew between the two.
 */
export const DEFAULT_REFRESH_MARGIN_SECONDS = 300;

/** How long one request to the endpoint may take. It is on the same host, so this is generous. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Something that hands out signing credentials valid for at least a given number of seconds.
 *
 * The number is the point: a presigned URL is signed now and redeemed later, and S3 refuses it once
 * the credentials that signed it have expired — whatever `X-Amz-Expires` says. So the adapter asks
 * for credentials that will outlive the URL it is about to issue.
 */
export interface SigningCredentialProvider {
  resolve(validForSeconds: number): Promise<SigningCredentials>;
}

export interface EcsTaskCredentialOptions {
  /** The value of `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`. */
  readonly relativeUri: string;
  readonly now: () => Date;
  /** Injected so a test can answer for the endpoint. */
  readonly fetch?: typeof globalThis.fetch;
  readonly refreshMarginSeconds?: number;
  readonly timeoutMs?: number;
}

interface CachedCredentials {
  readonly credentials: SigningCredentials;
  readonly expiresAt: Date;
}

export class EcsTaskCredentialProvider implements SigningCredentialProvider {
  private readonly url: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly marginSeconds: number;
  private readonly timeoutMs: number;
  private cached: CachedCredentials | null = null;
  /** The refresh in flight, so concurrent callers share one request rather than each sending one. */
  private inFlight: Promise<CachedCredentials> | null = null;

  constructor(private readonly options: EcsTaskCredentialOptions) {
    this.url = ecsCredentialsUrl(options.relativeUri);
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.marginSeconds = options.refreshMarginSeconds ?? DEFAULT_REFRESH_MARGIN_SECONDS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async resolve(validForSeconds: number): Promise<SigningCredentials> {
    if (this.covers(this.cached, validForSeconds)) {
      return this.cached.credentials;
    }
    const fresh = await this.refresh();
    if (!this.covers(fresh, validForSeconds)) {
      // Even brand-new credentials would expire before what is being signed. Issuing it anyway
      // would hand out a URL that stops working before its stated expiry, so refuse instead.
      throw new StorageUnavailableError(
        'The ECS task role credentials expire too soon to sign this request.',
      );
    }
    return fresh.credentials;
  }

  private covers(
    entry: CachedCredentials | null,
    validForSeconds: number,
  ): entry is CachedCredentials {
    if (entry === null) {
      return false;
    }
    const required = (Math.max(0, validForSeconds) + this.marginSeconds) * 1000;
    return entry.expiresAt.getTime() - this.options.now().getTime() >= required;
  }

  private refresh(): Promise<CachedCredentials> {
    if (this.inFlight === null) {
      this.inFlight = this.fetchCredentials()
        .then((entry) => {
          this.cached = entry;
          return entry;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  private async fetchCredentials(): Promise<CachedCredentials> {
    let response: Response;
    try {
      response = await this.fetch(this.url, {
        method: 'GET',
        // The endpoint never redirects. Following one would be the single way a request meant for
        // the task's own credentials could be sent somewhere else.
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new StorageUnavailableError(
        'The ECS task role credentials could not be obtained: the credential endpoint did not answer.',
        { cause },
      );
    }
    if (!response.ok) {
      throw new StorageUnavailableError(
        `The ECS task role credentials could not be obtained: the credential endpoint answered ${String(response.status)}.`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new StorageUnavailableError(
        'The ECS task role credentials could not be obtained: the credential endpoint answered with something that is not JSON.',
      );
    }
    return parseCredentials(body);
  }
}

/**
 * The full endpoint URL, refusing anything that would not resolve to the ECS credential host.
 *
 * ECS sets the variable to a path beginning with `/`. A value that does not — or one that, appended
 * to the host, would change the host, port or scheme — is not something ECS wrote, and following it
 * would send the request somewhere other than the task's own credential endpoint.
 */
export function ecsCredentialsUrl(relativeUri: string): string {
  if (!relativeUri.startsWith('/') || relativeUri.startsWith('//')) {
    throw new StorageUnavailableError(
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI must be a path beginning with "/".',
    );
  }
  const url = new URL(`http://${ECS_CREDENTIALS_HOST}${relativeUri}`);
  if (url.protocol !== 'http:' || url.host !== ECS_CREDENTIALS_HOST || url.username !== '') {
    throw new StorageUnavailableError(
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI does not resolve to the ECS credential endpoint.',
    );
  }
  return url.toString();
}

function parseCredentials(body: unknown): CachedCredentials {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const accessKeyId = record['AccessKeyId'];
  const secretAccessKey = record['SecretAccessKey'];
  const token = record['Token'];
  const expiration = record['Expiration'];
  const expiresAt = typeof expiration === 'string' ? new Date(expiration) : null;
  if (
    !nonEmpty(accessKeyId) ||
    !nonEmpty(secretAccessKey) ||
    !nonEmpty(token) ||
    expiresAt === null ||
    Number.isNaN(expiresAt.getTime())
  ) {
    // Which fields are expected is safe to say; what any of them contained is not.
    throw new StorageUnavailableError(
      'The ECS task role credentials could not be obtained: the credential endpoint answered without AccessKeyId, SecretAccessKey, Token and Expiration.',
    );
  }
  return {
    credentials: { accessKeyId, secretAccessKey, sessionToken: token },
    expiresAt,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
