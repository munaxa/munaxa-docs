import { inflateRawSync } from 'node:zlib';

/**
 * A ZIP central-directory reader — enough of the format to open an OOXML document, and no more.
 *
 * Written out rather than pulled in, for the same reason as the PNG codec beside it: an archive
 * library is a dependency an air-gapped installer has to carry for what is, here, a directory
 * walk and an `inflateRaw` call the runtime already ships. And the one security-relevant thing
 * about the format — a `.docx` bomb is a `.zip` bomb with a different extension — has to be
 * enforced *before* expansion either way, which means owning the loop that expands.
 *
 * What is deliberately not supported: encryption, multi-disk archives, ZIP64. An OOXML file
 * using any of them is refused, which for a preview is the honest answer — the upload itself
 * was already accepted as a document; this only decides whether text can be read out of it.
 */

export interface ZipLimits {
  /** Entries beyond this refuse the archive: a directory of a million files is an attack. */
  readonly maxEntries: number;
  /** Declared-to-compressed expansion beyond this refuses the entry before inflating. */
  readonly maxExpansionRatio: number;
  /** Ceiling on one inflated entry, enforced from the header before allocation. */
  readonly maxEntryBytes: number;
}

export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** EOCD is 22 bytes plus a comment of at most 65535. */
const EOCD_SEARCH_WINDOW = 22 + 0xffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

interface CentralRecord extends ZipEntry {
  readonly method: number;
  readonly localOffset: number;
}

/** The archive's directory, read without inflating anything. */
export function listZipEntries(bytes: Buffer, limits: ZipLimits): readonly ZipEntry[] {
  return readCentralDirectory(bytes, limits).map(({ name, compressedSize, uncompressedSize }) => ({
    name,
    compressedSize,
    uncompressedSize,
  }));
}

/**
 * One entry's bytes, by exact name. Null when the archive has no such entry.
 *
 * The declared uncompressed size is checked against every limit before a byte is inflated, and
 * checked *again* against what actually came out — a bomb that lies in its header is refused
 * twice, once cheaply and once decisively.
 */
export function readZipEntry(bytes: Buffer, name: string, limits: ZipLimits): Buffer | null {
  const record = readCentralDirectory(bytes, limits).find((entry) => entry.name === name);
  if (record === undefined) {
    return null;
  }
  return inflateEntry(bytes, record, limits);
}

/** Every entry whose name passes the filter, in directory order. */
export function readZipEntries(
  bytes: Buffer,
  filter: (name: string) => boolean,
  limits: ZipLimits,
): readonly { readonly name: string; readonly content: Buffer }[] {
  return readCentralDirectory(bytes, limits)
    .filter((entry) => filter(entry.name))
    .map((entry) => ({ name: entry.name, content: inflateEntry(bytes, entry, limits) }));
}

function readCentralDirectory(bytes: Buffer, limits: ZipLimits): readonly CentralRecord[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const total = bytes.readUInt16LE(eocd + 10);
  const disks = bytes.readUInt16LE(eocd + 4);
  if (disks !== 0) {
    throw new ZipError('A multi-disk archive is not something an OOXML file legitimately is.');
  }
  if (total > limits.maxEntries) {
    throw new ZipError(
      `The archive declares ${String(total)} entries; the cap is ${String(limits.maxEntries)}.`,
    );
  }
  const directoryOffset = bytes.readUInt32LE(eocd + 16);
  if (directoryOffset === 0xffffffff || total === 0xffff) {
    throw new ZipError('ZIP64 archives are not supported for preview.');
  }

  const records: CentralRecord[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < total; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('The central directory is truncated or corrupt.');
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    records.push({ name, method, compressedSize, uncompressedSize, localOffset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

function inflateEntry(bytes: Buffer, record: CentralRecord, limits: ZipLimits): Buffer {
  refuseBomb(record, limits);

  const header = record.localOffset;
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== LOCAL_SIGNATURE) {
    throw new ZipError('A local file header is missing where the directory pointed.');
  }
  const nameLength = bytes.readUInt16LE(header + 26);
  const extraLength = bytes.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + record.compressedSize;
  if (end > bytes.length) {
    throw new ZipError('An entry runs past the end of the archive.');
  }
  const compressed = bytes.subarray(start, end);

  if (record.method === METHOD_STORED) {
    return Buffer.from(compressed);
  }
  if (record.method !== METHOD_DEFLATED) {
    throw new ZipError(`Compression method ${String(record.method)} is not supported.`);
  }
  const inflated = inflateRawSync(compressed, { maxOutputLength: limits.maxEntryBytes });
  if (inflated.length !== record.uncompressedSize) {
    throw new ZipError('An entry inflated to a size its header did not declare.');
  }
  return inflated;
}

function refuseBomb(record: CentralRecord, limits: ZipLimits): void {
  if (record.uncompressedSize > limits.maxEntryBytes) {
    throw new ZipError(
      `Entry '${record.name}' declares ${String(record.uncompressedSize)} bytes; the cap is ${String(limits.maxEntryBytes)}.`,
    );
  }
  const ratio =
    record.compressedSize === 0
      ? record.uncompressedSize
      : record.uncompressedSize / record.compressedSize;
  if (ratio > limits.maxExpansionRatio) {
    throw new ZipError(
      `Entry '${record.name}' expands ${String(Math.round(ratio))}×; the cap is ${String(limits.maxExpansionRatio)}.`,
    );
  }
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const floor = Math.max(0, bytes.length - EOCD_SEARCH_WINDOW);
  for (let cursor = bytes.length - 22; cursor >= floor; cursor -= 1) {
    if (bytes.readUInt32LE(cursor) === EOCD_SIGNATURE) {
      return cursor;
    }
  }
  throw new ZipError('No end-of-central-directory record: not a ZIP archive, or truncated.');
}
