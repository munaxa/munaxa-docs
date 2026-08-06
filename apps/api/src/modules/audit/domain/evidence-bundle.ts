import { createHmac, timingSafeEqual } from 'node:crypto';

import { attestedFields, isChainHashVersion } from '../../../core/audit/hash-chain';
import { csvCell, csvCellUnguarded } from '../../../core/persistence/csv';

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
 * ## The CSV profile, and why Phase 18 did not simply fix the writer
 *
 * Phase 15 found that `evidenceCsvRow` quoted every field uniformly and neutralised no formula,
 * and that its own comment claimed the opposite. It deliberately left it alone, and its report
 * says exactly why: *"an evidence bundle's bytes are what a signed manifest's digest attests, and
 * rewriting the writer silently changes what a re-export of the same range produces"*. That
 * objection is correct and it is not an argument for leaving an injection in a file a compliance
 * officer opens.
 *
 * What it is an argument against is a **silent** change. So the rendering rule is now a named
 * profile carried on the manifest:
 *
 * - `RFC4180` — what every bundle produced before Phase 18 was written under. Uniform quoting,
 *   no neutralisation. Reachable by configuration, so an investigation can reproduce an old
 *   bundle's bytes exactly and check them against the digest in the manifest it already holds.
 * - `RFC4180_FORMULA_NEUTRALISED` — the default from Phase 18 onward, and what 15 §4's rule
 *   requires of any file this product hands to a spreadsheet.
 *
 * Three things make that honest rather than a version bump. **No hash changes**: a row's digest is
 * over the audit row's own fields (`hash-chain.ts`), never over the CSV rendering, so every
 * signature and every chain link written before this is unaffected and `attests` says exactly what
 * it always said. **An artefact digest is over the bytes actually written**, so a re-export under
 * a different profile produces a different `sha256` — which is the fact that had to become
 * legible rather than be avoided. And **the manifest states which profile produced it**, so
 * "these bytes differ from the bundle we took last year" has an answer in the file rather than in
 * somebody's memory of a release note. `manifestVersion` is `2` because a reader that does not
 * know about the field must not assume the old one.
 *
 * The JSONL is untouched, in both profiles. A JSON string is data to every reader of it, no
 * spreadsheet parses one as a formula, and neutralising there would corrupt the values an
 * automated verifier compares against the trail.
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

/**
 * How a cell is rendered — see the profile section at the head of this file.
 *
 * `RFC4180` is Phase 9's original behaviour, kept so an old bundle can be reproduced exactly.
 * `RFC4180_FORMULA_NEUTRALISED` is the default and what a spreadsheet may safely open.
 */
export const EvidenceCsvProfile = {
  RFC4180: 'RFC4180',
  RFC4180_FORMULA_NEUTRALISED: 'RFC4180_FORMULA_NEUTRALISED',
} as const;

export type EvidenceCsvProfileKey = (typeof EvidenceCsvProfile)[keyof typeof EvidenceCsvProfile];

export const DEFAULT_EVIDENCE_CSV_PROFILE: EvidenceCsvProfileKey =
  EvidenceCsvProfile.RFC4180_FORMULA_NEUTRALISED;

function cellWriter(profile: EvidenceCsvProfileKey): (value: string) => string {
  return profile === EvidenceCsvProfile.RFC4180 ? csvCellUnguarded : csvCell;
}

/**
 * The header row — bare column names, unchanged since Phase 9 and unchanged by the profile.
 *
 * Deliberately **not** run through the cell writer, and it is worth saying why rather than
 * leaving it to look like an omission. The profile exists so that a bundle produced before
 * Phase 18 can be reproduced byte-for-byte; quoting the header would change those bytes under
 * *both* profiles and break the one property the profile was added to preserve. It is also
 * unnecessary: the eighteen names are fixed in this file, none contains a comma, a quote or a
 * newline, and none begins with a formula leader — so there is nothing for either rule to do.
 */
export function evidenceCsvHeader(): string {
  return `${EVIDENCE_COLUMNS.join(',')}\n`;
}

/**
 * One CSV line.
 *
 * Every field is quoted, including the empty ones — but quoting is **not** what stops a formula:
 * a CSV reader strips the quotes before the spreadsheet parses the cell, so `"=1+1"` is a
 * formula. Under the default profile a cell beginning `=`, `+`, `-`, `@`, a tab or a carriage
 * return is prefixed with an apostrophe, which every spreadsheet reads as "the rest of this is
 * text". The rule itself lives in `core/persistence/csv.ts`, shared with the report writer so the
 * two cannot drift.
 */
export function evidenceCsvRow(
  row: EvidenceRow,
  profile: EvidenceCsvProfileKey = DEFAULT_EVIDENCE_CSV_PROFILE,
): string {
  const cell = cellWriter(profile);
  return `${EVIDENCE_COLUMNS.map((column) => cell(String(fieldOf(row, column)))).join(',')}\n`;
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
  /** Which rendering rule produced `events.csv` — Phase 18. See the profile section above. */
  readonly csvProfile: EvidenceCsvProfileKey;
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
  readonly manifestVersion: 2;
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
    manifestVersion: 2,
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
 * Moved to `core/persistence/stream-digest.ts` by Phase 15 and re-exported here, so every call
 * site in this module and its unit test are unchanged. It was the one thing in this file with
 * nothing to do with evidence — it hashes bytes — and a report export needs the same accumulator
 * to state what it wrote. The module boundary lint forbids reaching into another module's
 * `domain/`, correctly: a reporting service importing an *evidence bundle* would depend on this
 * phase's vocabulary rather than on a hash. That file records the rest of the reasoning.
 */
export { StreamDigest } from '../../../core/persistence/stream-digest';
