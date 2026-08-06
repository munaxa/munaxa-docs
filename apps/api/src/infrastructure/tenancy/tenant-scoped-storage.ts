import { Inject, Injectable } from '@nestjs/common';

import type { StorageDriverKey } from '@edms/domain';

import { ForbiddenError } from '../../core/errors/application-errors';
import { METRICS, MetricName, type Metrics } from '../../core/observability/metrics';
import { requireContext } from '../../core/tenancy/tenant-context';
import { TENANT_REGISTRY, type TenantRegistry } from '../../core/tenancy/tenant-registry.port';
import { NotFoundError } from '../../core/errors/application-errors';
import type {
  BlobMetadata,
  DownloadOptions,
  SignedUrl,
  StorageKey,
  StoragePort,
  UploadPart,
  UploadTarget,
  UploadTargetInput,
} from '../../ports/storage.port';

/**
 * The storage port, with the tenant's prefix put on every key and checked on every answer.
 *
 * This is the storage equivalent of what row-level security did for the database, and it exists for the
 * same reason. A `StorageKey` is a string, so nothing in the type system stops a use case from building
 * one that addresses another tenant's bytes — and one such key, once, is a breach. The prefix is
 * therefore not the caller's to supply: it is added here, from the ambient tenant's placement, and a
 * key that arrives already carrying somebody else's prefix is refused rather than silently re-prefixed
 * ([ADR-0015](../../../../../docs/architecture/adr/0015-database-per-tenant.md)).
 *
 * It wraps whichever adapter the driver selected. Isolation therefore does not depend on the adapter
 * getting it right: an S3 adapter written in a later phase inherits it, and so does a filesystem
 * adapter, and neither has to know a tenant exists.
 *
 * **A shared container with per-tenant prefixes and a container per tenant are the same code path
 * here.** The placement supplies both, the check is against both, and moving a tenant from one shape
 * to the other changes configuration rather than code.
 *
 * ## Phase 18 counts presigning here, and nowhere else
 *
 * `MetricName.STORAGE_PRESIGN` has been in the catalogue since Phase 0.5. This wrapper is the one
 * place every signed URL in the product passes through — the same property that makes it the
 * isolation boundary — so counting here cannot be forgotten by a caller, and there is no second
 * signing path for it to miss. The labels are the operation and the driver, both bounded sets in
 * code; the tenant is not a label, exactly as the rest of the catalogue.
 */
@Injectable()
export class TenantScopedStorage implements StoragePort {
  readonly driver: StorageDriverKey;

  constructor(
    private readonly inner: StoragePort,
    @Inject(TENANT_REGISTRY) private readonly registry: TenantRegistry,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {
    this.driver = inner.driver;
  }

  async createUploadTarget(input: UploadTargetInput): Promise<UploadTarget> {
    const key = await this.scope(input.key);
    const target = await this.inner.createUploadTarget({ ...input, key });
    this.metrics.increment(MetricName.STORAGE_PRESIGN, {
      operation: 'UPLOAD',
      driver: this.driver,
    });
    return { ...target, key: await this.unscope(target.key) };
  }

  async completeUpload(key: StorageKey, parts: readonly UploadPart[]): Promise<BlobMetadata> {
    const metadata = await this.inner.completeUpload(await this.scope(key), parts);
    return { ...metadata, key: await this.unscope(metadata.key) };
  }

  async createDownloadUrl(key: StorageKey, options: DownloadOptions): Promise<SignedUrl> {
    const url = await this.inner.createDownloadUrl(await this.scope(key), options);
    this.metrics.increment(MetricName.STORAGE_PRESIGN, {
      operation: 'DOWNLOAD',
      driver: this.driver,
    });
    return url;
  }

  async head(key: StorageKey): Promise<BlobMetadata | null> {
    const metadata = await this.inner.head(await this.scope(key));
    return metadata === null ? null : { ...metadata, key: await this.unscope(metadata.key) };
  }

  async copy(from: StorageKey, to: StorageKey): Promise<void> {
    // Both ends scoped, so a copy cannot be the way bytes leave a tenant. Deduplication across
    // tenants is deliberately impossible: two customers holding the same file is two objects, and the
    // storage saved by sharing one is not worth a reference count that spans a trust boundary.
    await this.inner.copy(await this.scope(from), await this.scope(to));
  }

  async delete(key: StorageKey): Promise<void> {
    await this.inner.delete(await this.scope(key));
  }

  async put(
    key: StorageKey,
    body: AsyncIterable<Uint8Array>,
    options: { readonly contentType: string },
  ): Promise<BlobMetadata> {
    const metadata = await this.inner.put(await this.scope(key), body, options);
    return { ...metadata, key: await this.unscope(metadata.key) };
  }

  async read(key: StorageKey): Promise<Buffer | null> {
    return this.inner.read(await this.scope(key));
  }

  /**
   * A listing, scoped at both ends.
   *
   * The prefix is scoped on the way in so one tenant cannot enumerate another's objects by
   * asking for an empty prefix — which is the one call in this port where an *absent* argument
   * would otherwise mean "everything". The keys are unscoped on the way out, so a caller sees
   * `audit/checkpoints/…` and never learns where its own bytes physically live.
   */
  async list(prefix: string): Promise<readonly StorageKey[]> {
    const scoped = await this.scope(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix);
    const keys = await this.inner.list(`${scoped}/`);
    return Promise.all(keys.map((key) => this.unscope(key)));
  }

  /**
   * The tenant's prefix, plus the caller's key.
   *
   * A key containing `..` is refused outright. For an object store it is merely a strange key; for the
   * filesystem adapter an on-premise installation runs, it is a path traversal out of the tenant's
   * directory — and the check belongs where every driver inherits it rather than in the one adapter
   * where it happens to be exploitable.
   */
  private async scope(key: StorageKey): Promise<StorageKey> {
    const prefix = await this.prefix();
    const trimmed = key.replace(/^\/+/, '');

    if (trimmed.length === 0) {
      throw new ForbiddenError('A storage key cannot be empty.');
    }
    if (trimmed.split('/').includes('..')) {
      throw new ForbiddenError('A storage key cannot traverse out of its tenant.');
    }
    if (trimmed === prefix || trimmed.startsWith(`${prefix}/`)) {
      // Already scoped. Re-prefixing would produce `acme/acme/…`, and silently accepting it would mean
      // two spellings of one object — so a caller that has evidently been handed a scoped key is told,
      // rather than served a second location for the same bytes.
      throw new ForbiddenError('A storage key must not include the tenant prefix.');
    }
    return `${prefix}/${trimmed}`;
  }

  /**
   * Strips the prefix from a key on its way back out.
   *
   * So that a document row stores `revisions/…` rather than `acme/revisions/…`: the prefix is where the
   * bytes live, not part of what the document *is*, and a stored key carrying it would have to be
   * rewritten if the tenant ever moved container.
   *
   * A key that comes back without the tenant's prefix is a failure, not something to pass through. It
   * would mean the adapter answered about an object outside the tenant, and the honest response to that
   * is to refuse rather than to hand it to a caller who cannot tell.
   */
  private async unscope(key: StorageKey): Promise<StorageKey> {
    const prefix = await this.prefix();
    if (!key.startsWith(`${prefix}/`)) {
      throw new ForbiddenError('Storage answered about an object outside this tenant.');
    }
    return key.slice(prefix.length + 1);
  }

  private async prefix(): Promise<string> {
    const { tenantId } = requireContext();
    const placement = await this.registry.byId(tenantId);
    if (!placement) {
      // The same answer the database gives for a tenant this deployment no longer serves.
      throw new NotFoundError('The requested resource');
    }
    return placement.storage.prefix;
  }
}
