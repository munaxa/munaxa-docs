import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { type TenantId, asId } from '@edms/domain';

import { APP_CONFIG, type AppConfig } from '../../../core/config';
import { LOGGER, type Logger } from '../../../core/observability/logger';
import { requireContext } from '../../../core/tenancy/tenant-context';
import { STORAGE_PORT, type StoragePort } from '../../../ports/storage.port';
import type { AuditCheckpoint, AuditCheckpointStore } from '../application/ports';

/**
 * Checkpoints, kept where the chain is not.
 *
 * `13-audit-architecture.md` §4: "Checkpoints are written to a separate store so an attacker
 * with database access alone cannot rewrite history undetected." A checkpoint row in the
 * database it attests would be ceremony — whoever rewrote the trail rewrites its attestation in
 * the same transaction — so the store is the object store, which is the one other durable place
 * this product has and which a database compromise does not reach.
 *
 * The signature is what makes the separation worth having. An attacker who reaches the bucket
 * *as well* can delete a checkpoint, and deleting one is loud: the next pass finds no checkpoint
 * where there should be a run of them. What they cannot do is write a checkpoint that agrees with
 * a doctored trail, because the key is held in the deployment's secret material rather than in
 * either store. Production refuses to boot without one.
 *
 * The object is written under a key derived from the sequence, zero-padded, so the store's own
 * lexicographic listing *is* the chronological one — and `latest()` is a bounded listing rather
 * than a scan. Prefixed by the tenant is unnecessary and would in fact be wrong: `TenantScopedStorage`
 * already puts every key inside the tenant's own placement, and a checkpoint that could name a
 * tenant in its key would be a checkpoint one tenant could address in another's space.
 */
const CHECKPOINT_ROOT = 'audit/checkpoints';
/** Enough for 10^18 events. A width that overflows would silently break the ordering. */
const SEQUENCE_WIDTH = 20;

@Injectable()
export class StorageCheckpointStore implements AuditCheckpointStore {
  constructor(
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Whether this deployment can write one at all.
   *
   * Two ways to be unable, and both are honest states rather than errors: no key to sign with,
   * and no object store to write to. A development environment normally has neither, verifies
   * the chain anyway, and reports `checkpointed: false` rather than writing something that looks
   * like evidence and is not.
   */
  get available(): boolean {
    // Read from configuration rather than from `storage.driver`: the adapter bound when nothing
    // is configured reports itself as `LOCAL` so that the rest of the product need not branch on
    // it, and asking it would answer "yes" for a store that rejects every call.
    return this.config.audit.checkpointSecret !== null && this.config.storage.driver !== 'NONE';
  }

  async write(checkpoint: AuditCheckpoint): Promise<void> {
    if (!this.available) {
      throw new Error('This deployment cannot write audit checkpoints.');
    }
    const body = Buffer.from(`${JSON.stringify(serialise(checkpoint), null, 2)}\n`, 'utf8');
    await this.storage.put(keyFor(checkpoint.sequence), single(body), {
      contentType: 'application/json',
    });
  }

  async latest(): Promise<AuditCheckpoint | null> {
    if (!this.available) {
      return null;
    }
    const keys = await this.storage.list(`${CHECKPOINT_ROOT}/`);
    const newest = [...keys].sort().at(-1);
    return newest === undefined ? null : this.read(newest);
  }

  async covering(fromSequence: bigint, toSequence: bigint): Promise<readonly AuditCheckpoint[]> {
    if (!this.available) {
      return [];
    }
    const keys = await this.storage.list(`${CHECKPOINT_ROOT}/`);
    const wanted = [...keys]
      .filter((key) => {
        const sequence = sequenceOf(key);
        return sequence !== null && sequence >= fromSequence && sequence <= toSequence;
      })
      .sort();

    const checkpoints: AuditCheckpoint[] = [];
    for (const key of wanted) {
      const checkpoint = await this.read(key);
      if (checkpoint !== null) {
        checkpoints.push(checkpoint);
      }
    }
    return checkpoints;
  }

  isAuthentic(checkpoint: AuditCheckpoint): boolean {
    const secret = this.config.audit.checkpointSecret;
    if (secret === null) {
      return false;
    }
    const expected = createHmac('sha256', secret).update(material(checkpoint), 'utf8').digest();
    const given = Buffer.from(checkpoint.signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /**
   * Reads one checkpoint back, and refuses one whose signature does not recompute.
   *
   * Returning `null` rather than throwing, and saying so loudly: a checkpoint that fails its own
   * signature is either corruption or the forgery the signature exists to catch, and in both
   * cases the correct behaviour is to verify from further back rather than to trust it.
   */
  private async read(key: string): Promise<AuditCheckpoint | null> {
    const raw = await this.storage.read(key);
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      this.logger.error('An audit checkpoint could not be parsed', { key });
      return null;
    }
    const checkpoint = deserialise(parsed);
    if (checkpoint === null) {
      this.logger.error('An audit checkpoint had an unreadable shape', { key });
      return null;
    }
    if (!this.isAuthentic(checkpoint)) {
      this.logger.error('An audit checkpoint failed its own signature', {
        key,
        sequence: checkpoint.sequence.toString(),
      });
      return null;
    }
    return checkpoint;
  }
}

/**
 * The material a checkpoint's signature covers.
 *
 * Field order fixed here rather than taken from the object, for the same reason the chain's own
 * canonical serialisation is: a signature that depended on key order would fail for reasons that
 * have nothing to do with forgery.
 */
export function material(checkpoint: AuditCheckpoint): string {
  return [
    checkpoint.tenantId,
    checkpoint.sequence.toString(),
    checkpoint.hash,
    checkpoint.verifiedAt.toISOString(),
    checkpoint.eventsVerified.toString(),
  ].join('|');
}

export function signCheckpoint(
  checkpoint: Omit<AuditCheckpoint, 'signature' | 'algorithm'>,
  secret: string,
): AuditCheckpoint {
  const unsigned: AuditCheckpoint = { ...checkpoint, signature: '', algorithm: 'HMAC-SHA256' };
  return {
    ...unsigned,
    signature: createHmac('sha256', secret).update(material(unsigned), 'utf8').digest('hex'),
  };
}

function keyFor(sequence: bigint): string {
  return `${CHECKPOINT_ROOT}/${sequence.toString().padStart(SEQUENCE_WIDTH, '0')}.json`;
}

function sequenceOf(key: string): bigint | null {
  const match = /\/(\d+)\.json$/.exec(key);
  return match?.[1] === undefined ? null : BigInt(match[1]);
}

function serialise(checkpoint: AuditCheckpoint) {
  return {
    tenantId: checkpoint.tenantId,
    sequence: checkpoint.sequence.toString(),
    hash: checkpoint.hash,
    verifiedAt: checkpoint.verifiedAt.toISOString(),
    eventsVerified: checkpoint.eventsVerified,
    algorithm: checkpoint.algorithm,
    signature: checkpoint.signature,
  };
}

function deserialise(value: unknown): AuditCheckpoint | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw['tenantId'] !== 'string' ||
    typeof raw['sequence'] !== 'string' ||
    typeof raw['hash'] !== 'string' ||
    typeof raw['verifiedAt'] !== 'string' ||
    typeof raw['eventsVerified'] !== 'number' ||
    typeof raw['signature'] !== 'string'
  ) {
    return null;
  }
  return {
    tenantId: asId<TenantId>(raw['tenantId']),
    sequence: BigInt(raw['sequence']),
    hash: raw['hash'],
    verifiedAt: new Date(raw['verifiedAt']),
    eventsVerified: raw['eventsVerified'],
    signature: raw['signature'],
    algorithm: 'HMAC-SHA256',
  };
}

/** A one-chunk stream, so a small object goes through the same streaming write as a large one. */
// eslint-disable-next-line @typescript-eslint/require-await -- a generator, not a task
async function* single(body: Buffer): AsyncIterable<Uint8Array> {
  yield new Uint8Array(body);
}

/** The current tenant, for a checkpoint about to be written. */
export function checkpointTenant(): TenantId {
  return requireContext().tenantId;
}
