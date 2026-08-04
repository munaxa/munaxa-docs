import {
  type FileFormat,
  FileFormatFamily,
  type FileFormatFamilyKey,
  SUPPORTED_MIME_TYPES,
  formatFor,
  normalizeMimeType,
  sniffFormat,
} from '@edms/domain';

/**
 * What may be uploaded, and in what order the question is asked.
 *
 * The order *is* the security property (`17-security-architecture.md` §5). Type before size,
 * content before declaration, and everything before a byte is stored: a pipeline that scans last,
 * or that trusts an extension, is the standard way a document system ships malware to its own
 * users. Every check here runs before a presigned target is issued, so a refused upload is one
 * that never occupied storage at all.
 *
 * Pure, and deliberately so. The whole of "may this file be stored" is decidable from the
 * candidate, the policy and the leading bytes — which is what lets it be tested exhaustively
 * without a database, a network or a temporary file.
 */

export interface UploadCandidate {
  readonly filename: string;
  readonly declaredMimeType: string;
  readonly sizeBytes: number;
  /** The leading bytes, for content sniffing. Never the whole file. */
  readonly magicBytes: Uint8Array;
}

export interface UploadPolicy {
  readonly allowedMimeTypes: readonly string[];
  /** A ceiling per family, because a scanned drawing and a text file are not the same object. */
  readonly maxBytesByFamily: Readonly<Partial<Record<FileFormatFamilyKey, number>>>;
  readonly maxBytesDefault: number;
  readonly archiveLimits: {
    readonly maxDepth: number;
    readonly maxEntries: number;
    /** Uncompressed-to-compressed ratio above which the archive is refused. */
    readonly maxExpansionRatio: number;
  };
}

export type UploadRejectionReason =
  'EMPTY' | 'TYPE_NOT_ALLOWED' | 'TYPE_MISMATCH' | 'TOO_LARGE' | 'FILENAME_UNUSABLE';

export interface UploadRejection {
  readonly reason: UploadRejectionReason;
  readonly detail: string;
}

export interface UploadAcceptance {
  /** The *sniffed* format. What is stored — never the declared type. */
  readonly format: FileFormat;
  /** Whether the archive limits have to be applied when anything expands it. */
  readonly requiresArchiveLimits: boolean;
}

/**
 * The default policy, before a tenant narrows it.
 *
 * Every format the product supports is allowed, with a ceiling per family chosen from what those
 * files actually weigh: a text file that is 500 MB is not a text file anybody meant to upload, and
 * refusing it early costs a mistyped upload rather than half an hour of transfer. The families
 * that legitimately get large — drawings, scanned TIFFs, archives — get the deployment's own
 * ceiling.
 *
 * A tenant may only ever *narrow* this. That is not enforced by an argument type but by where the
 * narrowing happens: the settings a tenant edits are intersected with this, so an allow-list a
 * customer writes cannot introduce a format the product has no sniffer for.
 */
export function defaultUploadPolicy(maxUploadBytes: number): UploadPolicy {
  const megabytes = (count: number): number => Math.min(count * 1024 * 1024, maxUploadBytes);
  return {
    allowedMimeTypes: SUPPORTED_MIME_TYPES,
    maxBytesByFamily: {
      [FileFormatFamily.TEXT]: megabytes(32),
      [FileFormatFamily.WORD]: megabytes(128),
      [FileFormatFamily.EXCEL]: megabytes(128),
      [FileFormatFamily.POWERPOINT]: megabytes(256),
      [FileFormatFamily.PDF]: megabytes(512),
      [FileFormatFamily.IMAGE]: megabytes(256),
      // A drawing set and a project archive are the two things people legitimately upload by the
      // gigabyte, so both take the deployment's own ceiling rather than a family one.
      [FileFormatFamily.DRAWING]: maxUploadBytes,
      [FileFormatFamily.ARCHIVE]: maxUploadBytes,
    },
    maxBytesDefault: maxUploadBytes,
    archiveLimits: {
      maxDepth: 8,
      maxEntries: 10_000,
      // A zip bomb's whole trick is a ratio in the thousands. A hundred still admits every
      // legitimately compressible archive — a directory of CAD files or XML compresses well, but
      // not by two orders of magnitude.
      maxExpansionRatio: 100,
    },
  };
}

/**
 * Whether this file may be stored, and what it actually is.
 *
 * The checks run in the order the architecture specifies, and each one is cheaper than the next:
 *
 * 1. **A name that can be written down.** Not a security check — the stored key is the digest —
 *    but a name that sanitises to something different is a name the person will not recognise on
 *    the download, and silently renaming it is worse than refusing it.
 * 2. **Not empty.** A zero-byte file is a mis-drag or a failed export, and content addressing
 *    would give every one of them the same digest — so every empty upload in a tenant would
 *    deduplicate into a single blob that many documents claim as their content.
 * 3. **Declared type in the allow-list.** Cheap, and it is the list that decides what a sniff is
 *    even permitted to conclude.
 * 4. **Declared type matches the bytes.** The check that matters. See `sniffFormat`.
 * 5. **Size within the family's ceiling.** Last of the four because it is the only one whose
 *    answer depends on which format this turned out to be.
 */
export function checkUpload(
  candidate: UploadCandidate,
  policy: UploadPolicy,
): UploadAcceptance | UploadRejection {
  const filename = candidate.filename.trim();
  if (filename.length === 0 || filename.length > 255) {
    return { reason: 'FILENAME_UNUSABLE', detail: 'A file needs a name of up to 255 characters.' };
  }
  if (candidate.sizeBytes <= 0) {
    return { reason: 'EMPTY', detail: 'That file is empty.' };
  }

  const declared = normalizeMimeType(candidate.declaredMimeType);
  if (!policy.allowedMimeTypes.includes(declared)) {
    return {
      reason: 'TYPE_NOT_ALLOWED',
      detail: `${describe(declared)} cannot be stored in this library.`,
    };
  }

  const sniffed = sniffFormat(declared, candidate.magicBytes);
  if (sniffed === null || sniffed.mimeType !== declared) {
    // The message says what the file *is* when that is known, because "this is a PNG, not a PDF"
    // is something the person can act on, while "type mismatch" is not. It never claims a type
    // that is not in the allow-list — a refused format is refused, not described.
    return {
      reason: 'TYPE_MISMATCH',
      detail:
        sniffed === null
          ? `This file is not a ${describe(declared)}.`
          : `This file is a ${sniffed.label}, not a ${describe(declared)}.`,
    };
  }

  const ceiling = policy.maxBytesByFamily[sniffed.family] ?? policy.maxBytesDefault;
  if (candidate.sizeBytes > ceiling) {
    return {
      reason: 'TOO_LARGE',
      detail: `A ${sniffed.label} may be up to ${formatBytes(ceiling)}.`,
    };
  }

  return { format: sniffed, requiresArchiveLimits: sniffed.zipContainer };
}

export function isRejection(result: UploadAcceptance | UploadRejection): result is UploadRejection {
  return 'reason' in result;
}

/**
 * The tenant's policy, which can only be a narrowing of the product's.
 *
 * A configured allow-list is intersected rather than substituted, and a configured ceiling is
 * taken as the smaller of the two. That direction is the point: an administrator restricting what
 * their organisation accepts is ordinary configuration, and one *widening* it would be
 * configuration that introduces a format nothing here can sniff — a check the product cannot
 * perform, expressed as a setting.
 */
export function narrowPolicy(
  base: UploadPolicy,
  narrowing: {
    readonly allowedMimeTypes?: readonly string[] | undefined;
    readonly maxBytes?: number | undefined;
  },
): UploadPolicy {
  const allowed =
    narrowing.allowedMimeTypes === undefined
      ? base.allowedMimeTypes
      : base.allowedMimeTypes.filter((mimeType) => narrowing.allowedMimeTypes?.includes(mimeType));
  if (narrowing.maxBytes === undefined) {
    return { ...base, allowedMimeTypes: allowed };
  }
  const ceiling = Math.min(narrowing.maxBytes, base.maxBytesDefault);
  return {
    ...base,
    allowedMimeTypes: allowed,
    maxBytesDefault: ceiling,
    maxBytesByFamily: Object.fromEntries(
      Object.entries(base.maxBytesByFamily).map(([family, bytes]) => [
        family,
        Math.min(bytes ?? ceiling, ceiling),
      ]),
    ),
  };
}

function describe(mimeType: string): string {
  return formatFor(mimeType)?.label ?? `a file of type ${mimeType}`;
}

/** Bytes as somebody would say them. Used only in refusal messages. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'bytes'}`;
}
