import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { attestedFields, isChainHashVersion } from '../../../core/audit/hash-chain';

/**
 * What an evidence bundle *is*, as a pure function of the rows it covers.
 *
 * `13-audit-architecture.md` §6 asks for "a signed bundle (CSV/JSONL + checkpoint hashes + a
 * manifest)". Everything about that shape which does not need a database or a bucket lives here,
 * so the property an auditor cares about — the manifest's digests match the bytes, and the
 * signature matches the manifest — is a unit test rather than an integration one.
 *
 * ## What the bundle claims, and what it does not
 *
 * This is the honesty clause, and it is the reason `attests` exists.
 *
 * The chain proves what its digest covers, and no more. Rows written before Phase 9 carry the v1
 * digest, which covers nine fields and *not* `sequence`, `channel`, `on_behalf_of_id`, `reason`,
 * `correlation_id`, `ip_address` or `user_agent`. Those columns are still exported — they are
 * facts the trail recorded, and withholding them would make the bundle less useful without making
 * it more honest — but the manifest states, per digest version present in the range, exactly which
 * columns that version's hash attests. A bundle that listed every column beside a v1 hash would be
 * asserting attestation the digest never provided, and an evidence bundle that overclaims is worse
 * than no bundle at all.
 *
 * ## Why the manifest is signed rather than chained
 *
 * The bundle is a copy. Chaining it would produce a second chain to keep, and the question a
 * bundle answers is not "has this bundle been edited" but "is this bundle what the trail said".
 * The manifest carries the range's first and last sequence and digest, so the answer is obtained
 * by re-reading the trail — and the signature, with a key held outside both the database and the
 * bucket, is what stops the bundle *and* its manifest being rewritten together.
 */

/** One row, as it goes onto the wire and into the digest. */
export interface EvidenceRow {
  readonly id: string;
  readonly sequence: bigint;
  readonly occurredAt: Date;
  readonly actorId: string | null;
  readonly onBehalfOfId: string | null;
  readonly channel: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly reason: string | null;
  readonly correlationId: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly hash: string;
  readonly previousHash: string;
  readonly chainHashVersion: number;
}

/**
 * The column order of the CSV, and the key order of the JSONL.
 *
 * Fixed here rather than derived from the row object, because a column order that depended on
 * object construction would change silently and every downstream spreadsheet with it.
 */
export const EVIDENCE_COLUMNS = Object.freeze([
  'sequence',
  'id',
  'occurredAt',
  'action',
  'outcome',
  'subjectType',
  'subjectId',
  'actorId',
  'onBehalfOfId',
  'channel',
  'reason',
  'correlationId',
  'ipAddress',
  'userAgent',
  'payload',
  'previousHash',
  'hash',
  'chainHashVersion',
] as const);

export function evidenceCsvHeader(): string {
  return `${EVIDENCE_COLUMNS.join(',')}\n`;
}

/**
 * One CSV line.
 *
 * Every field is quoted, including the empty ones. A conditional quoting rule is where an
 * injection into a spreadsheet formula hides, and a uniform one costs two bytes a field.
 */
export function evidenceCsvRow(row: EvidenceRow): string {
  return `${EVIDENCE_COLUMNS.map((column) => csvCell(fieldOf(row, column))).join(',')}\n`;
}

/** One JSONL line — the same fields, in the same order, without the flattening. */
export function evidenceJsonlRow(row: EvidenceRow): string {
  const record: Record<string, unknown> = {};
  for (const column of EVIDENCE_COLUMNS) {
    record[column] = column === 'payload' ? row.payload : fieldOf(row, column);
  }
  return `${JSON.stringify(record)}\n`;
}

function fieldOf(row: EvidenceRow, column: (typeof EVIDENCE_COLUMNS)[number]): string | number {
  switch (column) {
    case 'sequence':
      return row.sequence.toString();
    case 'occurredAt':
      return row.occurredAt.toISOString();
    case 'payload':
      return JSON.stringify(row.payload);
    case 'chainHashVersion':
      return row.chainHashVersion;
    default:
      return row[column] ?? '';
  }
}

function csvCell(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/** One object in the bundle, with the digest of the bytes actually written. */
export interface BundleArtefact {
  readonly name: string;
  readonly storageKey: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /**
   * The `file_object` row the artefact was stored as.
   *
   * Carried so the download goes through Storage's own audited `createDownloadUrl` rather than a
   * second signing path beside it — which would be a second place `FILE_DOWNLOAD_ISSUED` has to
   * be remembered. Deliberately absent from the manifest: it is an internal identifier and says
   * nothing to an auditor verifying digests.
   */
  readonly fileObjectId: string;
}

/** A signed checkpoint covering some part of the range, copied into the bundle as evidence. */
export interface BundleCheckpoint {
  readonly sequence: string;
  readonly hash: string;
  readonly verifiedAt: string;
  readonly signature: string;
}

export interface BundleManifestInput {
  readonly exportId: string;
  readonly tenantId: string;
  readonly requestedById: string;
  readonly requestedAt: Date;
  readonly producedAt: Date;
  readonly from: Date;
  readonly to: Date;
  readonly filters: Readonly<Record<string, string>>;
  readonly eventCount: number;
  readonly firstSequence: bigint | null;
  readonly lastSequence: bigint | null;
  readonly firstPreviousHash: string | null;
  readonly lastHash: string | null;
  /** Every digest version present in the range — what the `attests` section is keyed on. */
  readonly hashVersions: readonly number[];
  readonly chain: {
    readonly intact: boolean;
    readonly brokenAtEventId: string | null;
    readonly reason: string | null;
    readonly verified: number;
  };
  readonly checkpoints: readonly BundleCheckpoint[];
  readonly artefacts: readonly BundleArtefact[];
}

export interface BundleManifest extends Omit<
  BundleManifestInput,
  | 'requestedAt'
  | 'producedAt'
  | 'from'
  | 'to'
  | 'firstSequence'
  | 'lastSequence'
  | 'hashVersions'
  | 'artefacts'
> {
  readonly manifestVersion: 1;
  readonly requestedAt: string;
  readonly producedAt: string;
  readonly from: string;
  readonly to: string;
  readonly firstSequence: string | null;
  readonly lastSequence: string | null;
  /** Name, media type, size and digest — everything a verifier needs and nothing internal. */
  readonly artefacts: readonly Omit<BundleArtefact, 'fileObjectId'>[];
  /**
   * What the hash on each row actually proves, by digest version.
   *
   * The bundle's honesty clause, rendered as data so a verifier can act on it rather than a
   * reader having to know the product's history.
   */
  readonly attests: readonly {
    readonly chainHashVersion: number;
    readonly fields: readonly string[];
    readonly note: string;
  }[];
}

const V1_NOTE =
  'Written before the digest was widened. The exported reason, channel, delegate, correlation id, ' +
  'address, agent and sequence are recorded facts but are NOT covered by this row’s hash.';
const V2_NOTE = 'Every exported column except the hashes themselves is covered by this row’s hash.';

export function buildManifest(input: BundleManifestInput): BundleManifest {
  const {
    requestedAt,
    producedAt,
    from,
    to,
    firstSequence,
    lastSequence,
    hashVersions,
    artefacts,
    ...rest
  } = input;
  return {
    manifestVersion: 1,
    ...rest,
    artefacts: artefacts.map(({ fileObjectId: _internal, ...artefact }) => artefact),
    requestedAt: requestedAt.toISOString(),
    producedAt: producedAt.toISOString(),
    from: from.toISOString(),
    to: to.toISOString(),
    firstSequence: firstSequence === null ? null : firstSequence.toString(),
    lastSequence: lastSequence === null ? null : lastSequence.toString(),
    attests: [...new Set(hashVersions)]
      .sort((left, right) => left - right)
      .map((version) => ({
        chainHashVersion: version,
        fields: isChainHashVersion(version) ? attestedFields(version) : [],
        note: version === 1 ? V1_NOTE : V2_NOTE,
      })),
  };
}

/**
 * The manifest, serialised exactly once.
 *
 * The signature is over these bytes rather than over a re-serialisation, so verification never
 * depends on two `JSON.stringify` calls agreeing about key order.
 */
export function serialiseManifest(manifest: BundleManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export interface SignedManifest {
  readonly body: string;
  readonly signature: string;
  readonly algorithm: 'HMAC-SHA256';
}

export function signManifest(body: string, secret: string): SignedManifest {
  return {
    body,
    signature: createHmac('sha256', secret).update(body, 'utf8').digest('hex'),
    algorithm: 'HMAC-SHA256',
  };
}

/** Constant-time, because a signature check that leaks its own progress is not a check. */
export function verifyManifestSignature(body: string, signature: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * A digest accumulated over bytes as they stream past.
 *
 * The manifest has to state the digest of an artefact the process never held in one piece, so it
 * is computed on the way through rather than by reading the object back — which would also mean
 * trusting the store to return what it was given.
 */
export class StreamDigest {
  private readonly hash = createHash('sha256');
  private bytes = 0;

  update(chunk: Uint8Array): void {
    this.hash.update(chunk);
    this.bytes += chunk.byteLength;
  }

  get sizeBytes(): number {
    return this.bytes;
  }

  digest(): string {
    return this.hash.digest('hex');
  }
}
