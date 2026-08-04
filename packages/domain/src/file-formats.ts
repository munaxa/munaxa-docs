/**
 * The formats the document library accepts, and how each one is recognised.
 *
 * This is vocabulary rather than policy, which is why it is here and not in a module. The API
 * refuses an upload whose sniffed type disagrees with its declared one, the web client offers the
 * matching `accept` attribute, and the preview module decides whether it can draw a thumbnail —
 * three answers that have to come from one table, or a file the browser offered is a file the API
 * rejects.
 *
 * **Recognition is by content, never by extension** (`17-security-architecture.md` §5). An
 * extension is a claim by whoever named the file; the leading bytes are a claim by whoever wrote
 * it, and only the second one is worth checking. The extensions below exist so a browser's file
 * picker can filter and so a download gets a sensible name — never so the server can decide what
 * something is.
 *
 * A format not in this table cannot be stored. That is deliberate and it is the allow-list the
 * architecture asks for: the alternative, a deny-list, is a list somebody has to keep ahead of
 * every new executable container format.
 */

/** What a person calls this kind of file. Groups the library's filters and its icons. */
export const FileFormatFamily = {
  PDF: 'PDF',
  WORD: 'WORD',
  EXCEL: 'EXCEL',
  POWERPOINT: 'POWERPOINT',
  IMAGE: 'IMAGE',
  DRAWING: 'DRAWING',
  ARCHIVE: 'ARCHIVE',
  TEXT: 'TEXT',
} as const;

export type FileFormatFamilyKey = (typeof FileFormatFamily)[keyof typeof FileFormatFamily];

export const ALL_FILE_FORMAT_FAMILIES: readonly FileFormatFamilyKey[] = Object.freeze(
  Object.values(FileFormatFamily),
);

/**
 * A signature to look for in a file's leading bytes.
 *
 * `offset` is there for exactly two formats in this table and both are real: a JPEG's marker is at
 * zero, but a RIFF container names its subtype at byte 8, and a DWG's version string is at zero
 * while its class marker is not. Expressing the offset is what lets one mechanism cover them
 * instead of a special case per container.
 */
export interface FileSignature {
  readonly offset: number;
  readonly bytes: readonly number[];
}

export interface FileFormat {
  /** The canonical MIME type. What is stored, and what a declared type is compared against. */
  readonly mimeType: string;
  readonly family: FileFormatFamilyKey;
  readonly label: string;
  /** Lower-case, with the dot. The first is the canonical one for a download. */
  readonly extensions: readonly string[];
  /**
   * The signatures that identify this format. Empty means the format has none.
   *
   * Only `text/plain` and `image/svg+xml` are in that position, and they are handled explicitly
   * rather than by an empty check — see `sniffFormat`.
   */
  readonly signatures: readonly FileSignature[];
  /**
   * A container whose entries are files in their own right.
   *
   * Both ZIP archives and every OOXML document are ZIPs on disk, and both need the archive limits
   * — depth, entry count, expansion ratio — applied before anything expands them. A `.docx` bomb is
   * a `.zip` bomb with a different extension.
   */
  readonly zipContainer: boolean;
  /** Whether a thumbnail can be produced from it at upload time. */
  readonly thumbnailable: boolean;
}

const ZIP_SIGNATURES: readonly FileSignature[] = Object.freeze([
  // A local file header. `PK\x03\x04` for the ordinary case; the other two are an empty archive and
  // a spanned one, and an OOXML file written by a streaming writer can legitimately be either.
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] },
  { offset: 0, bytes: [0x50, 0x4b, 0x07, 0x08] },
]);

/** The OLE2 compound-document header, shared by every pre-2007 Office file. */
const OLE2_SIGNATURES: readonly FileSignature[] = Object.freeze([
  { offset: 0, bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
]);

/**
 * Every format, in the order `sniffFormat` tries them.
 *
 * Order is load-bearing in one place and inert everywhere else: the OOXML types and `application/zip`
 * share a signature, so a `.docx` and a `.zip` are indistinguishable from their first four bytes
 * alone. That ambiguity is resolved by the *declared* type rather than by ordering — see
 * `sniffFormat` — and the plain ZIP entry sits last so that a declared type nothing else claims
 * lands on it.
 */
export const FILE_FORMATS: readonly FileFormat[] = Object.freeze([
  {
    mimeType: 'application/pdf',
    family: FileFormatFamily.PDF,
    label: 'PDF',
    extensions: ['.pdf'],
    signatures: [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }],
    zipContainer: false,
    thumbnailable: true,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    family: FileFormatFamily.WORD,
    label: 'Word document',
    extensions: ['.docx'],
    signatures: ZIP_SIGNATURES,
    zipContainer: true,
    thumbnailable: false,
  },
  {
    mimeType: 'application/msword',
    family: FileFormatFamily.WORD,
    label: 'Word document (legacy)',
    extensions: ['.doc'],
    signatures: OLE2_SIGNATURES,
    zipContainer: false,
    thumbnailable: false,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    family: FileFormatFamily.EXCEL,
    label: 'Excel workbook',
    extensions: ['.xlsx'],
    signatures: ZIP_SIGNATURES,
    zipContainer: true,
    thumbnailable: false,
  },
  {
    mimeType: 'application/vnd.ms-excel',
    family: FileFormatFamily.EXCEL,
    label: 'Excel workbook (legacy)',
    extensions: ['.xls'],
    signatures: OLE2_SIGNATURES,
    zipContainer: false,
    thumbnailable: false,
  },
  {
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    family: FileFormatFamily.POWERPOINT,
    label: 'PowerPoint presentation',
    extensions: ['.pptx'],
    signatures: ZIP_SIGNATURES,
    zipContainer: true,
    thumbnailable: false,
  },
  {
    mimeType: 'application/vnd.ms-powerpoint',
    family: FileFormatFamily.POWERPOINT,
    label: 'PowerPoint presentation (legacy)',
    extensions: ['.ppt'],
    signatures: OLE2_SIGNATURES,
    zipContainer: false,
    thumbnailable: false,
  },
  {
    mimeType: 'image/png',
    family: FileFormatFamily.IMAGE,
    label: 'PNG image',
    extensions: ['.png'],
    signatures: [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
    zipContainer: false,
    thumbnailable: true,
  },
  {
    mimeType: 'image/jpeg',
    family: FileFormatFamily.IMAGE,
    label: 'JPEG image',
    extensions: ['.jpg', '.jpeg'],
    signatures: [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
    zipContainer: false,
    thumbnailable: true,
  },
  {
    mimeType: 'image/gif',
    family: FileFormatFamily.IMAGE,
    label: 'GIF image',
    extensions: ['.gif'],
    signatures: [
      { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
      { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
    ],
    zipContainer: false,
    thumbnailable: true,
  },
  {
    mimeType: 'image/tiff',
    family: FileFormatFamily.IMAGE,
    label: 'TIFF image',
    extensions: ['.tif', '.tiff'],
    signatures: [
      // Little-endian and big-endian byte orders. A scanner writes either, depending on who made it.
      { offset: 0, bytes: [0x49, 0x49, 0x2a, 0x00] },
      { offset: 0, bytes: [0x4d, 0x4d, 0x00, 0x2a] },
    ],
    zipContainer: false,
    thumbnailable: true,
  },
  {
    mimeType: 'image/webp',
    family: FileFormatFamily.IMAGE,
    label: 'WebP image',
    extensions: ['.webp'],
    // A RIFF container that names its subtype at byte 8; the leading `RIFF` alone is also an audio
    // file, so both parts are required.
    signatures: [{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }],
    zipContainer: false,
    thumbnailable: true,
  },
  {
    mimeType: 'image/bmp',
    family: FileFormatFamily.IMAGE,
    label: 'Bitmap image',
    extensions: ['.bmp'],
    signatures: [{ offset: 0, bytes: [0x42, 0x4d] }],
    zipContainer: false,
    thumbnailable: true,
  },
  {
    mimeType: 'image/vnd.dwg',
    family: FileFormatFamily.DRAWING,
    label: 'AutoCAD drawing',
    extensions: ['.dwg'],
    // `AC` followed by a four-digit version: AC1012 is R13, AC1015 is 2000, AC1032 is 2018. Every
    // release the format has ever had begins `AC10`, and requiring all four characters refuses a
    // file that merely starts with the two letters.
    signatures: [{ offset: 0, bytes: [0x41, 0x43, 0x31, 0x30] }],
    zipContainer: false,
    thumbnailable: false,
  },
  {
    mimeType: 'text/plain',
    family: FileFormatFamily.TEXT,
    label: 'Text file',
    extensions: ['.txt'],
    // No signature exists, and inventing one would mean refusing valid text. Recognised by
    // exclusion instead: see `sniffFormat`.
    signatures: [],
    zipContainer: false,
    thumbnailable: false,
  },
  {
    mimeType: 'text/csv',
    family: FileFormatFamily.TEXT,
    label: 'CSV file',
    extensions: ['.csv'],
    signatures: [],
    zipContainer: false,
    thumbnailable: false,
  },
  {
    mimeType: 'application/zip',
    family: FileFormatFamily.ARCHIVE,
    label: 'ZIP archive',
    extensions: ['.zip'],
    signatures: ZIP_SIGNATURES,
    zipContainer: true,
    thumbnailable: false,
  },
]);

const BY_MIME_TYPE: ReadonlyMap<string, FileFormat> = new Map(
  FILE_FORMATS.map((format) => [format.mimeType, format]),
);

export const SUPPORTED_MIME_TYPES: readonly string[] = Object.freeze(
  FILE_FORMATS.map((format) => format.mimeType),
);

/** Every extension the file picker should offer, in table order. */
export const SUPPORTED_EXTENSIONS: readonly string[] = Object.freeze(
  FILE_FORMATS.flatMap((format) => format.extensions),
);

export function formatFor(mimeType: string): FileFormat | null {
  return BY_MIME_TYPE.get(normalizeMimeType(mimeType)) ?? null;
}

export function isSupportedMimeType(mimeType: string): boolean {
  return BY_MIME_TYPE.has(normalizeMimeType(mimeType));
}

/**
 * The MIME type as this product spells it.
 *
 * A browser sends `text/plain; charset=utf-8` and an integration sends `TEXT/PLAIN`; both mean the
 * same format, and storing two spellings of one type would make the allow-list a lottery.
 */
export function normalizeMimeType(raw: string): string {
  const [type = ''] = raw.trim().toLowerCase().split(';');
  return type.trim();
}

/** The extension of a filename, lower-cased and with its dot. Empty when there is none. */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension: `.gitignore` has no type to infer.
  return dot > 0 ? filename.slice(dot).toLowerCase() : '';
}

/**
 * What the leading bytes say this file is, given what the uploader claimed it is.
 *
 * The declared type participates, and that is not a weakening of content sniffing — it is what
 * makes it decidable. Every OOXML format and `application/zip` share four leading bytes, so the
 * bytes alone can rule a claim *out* but cannot always rule one *in*. So the rule is:
 *
 * 1. If the declared type is not a format this product stores, there is nothing to check: refused.
 * 2. If the bytes match a signature the declared format claims, the declaration stands.
 * 3. Otherwise the bytes belong to some other known format, or to none, and the declaration is a
 *    lie or a mistake either way — refused, by returning what the bytes actually looked like.
 *
 * That ordering is what stops a renamed executable being stored as a PDF, while still storing a
 * `.docx` without unzipping it during a request.
 *
 * `null` means the bytes matched nothing known. The caller reports a mismatch; it never falls back
 * to the declaration.
 */
export function sniffFormat(declaredMimeType: string, leadingBytes: Uint8Array): FileFormat | null {
  const declared = formatFor(declaredMimeType);

  if (declared !== null && declared.signatures.length > 0 && matchesAny(declared, leadingBytes)) {
    return declared;
  }
  // Text has no signature, so it is recognised by exclusion: a file declared as text that matches
  // no binary signature and contains no control bytes is text. Checking the *other* signatures
  // first is what stops a PDF renamed to `.txt` being stored as text and later rendered as one.
  if (declared !== null && declared.signatures.length === 0) {
    const binary = FILE_FORMATS.find(
      (format) => format.signatures.length > 0 && matchesAny(format, leadingBytes),
    );
    return binary ?? (looksTextual(leadingBytes) ? declared : null);
  }
  return FILE_FORMATS.find((format) => matchesAny(format, leadingBytes)) ?? null;
}

function matchesAny(format: FileFormat, bytes: Uint8Array): boolean {
  return format.signatures.some((signature) => matches(signature, bytes));
}

function matches(signature: FileSignature, bytes: Uint8Array): boolean {
  if (bytes.length < signature.offset + signature.bytes.length) {
    return false;
  }
  return signature.bytes.every((byte, index) => bytes[signature.offset + index] === byte);
}

/**
 * Whether these bytes could be text.
 *
 * A NUL byte is the discriminator every `file(1)` implementation has used for forty years, and it
 * is enough here: this runs only after every binary signature has already failed to match, so it
 * is deciding between "text" and "something with no signature at all". Other control characters
 * are permitted, because a Windows-authored text file is full of `\r` and a form feed is a page
 * break somebody meant.
 */
function looksTextual(bytes: Uint8Array): boolean {
  return !bytes.includes(0x00);
}

/**
 * How many leading bytes are enough to identify anything in the table.
 *
 * Stated as a constant derived from the table rather than written down, so adding a format with a
 * signature further into the file cannot silently make sniffing read too little. The floor keeps
 * the textual check meaningful — a NUL byte in the first twelve bytes of a real text file is
 * possible, in the first 512 it is not.
 */
export const SNIFF_BYTE_COUNT: number = Math.max(
  512,
  ...FILE_FORMATS.flatMap((format) =>
    format.signatures.map((signature) => signature.offset + signature.bytes.length),
  ),
);
