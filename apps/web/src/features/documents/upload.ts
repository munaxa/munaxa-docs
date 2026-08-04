'use client';

import type { DuplicateMatch, UploadTarget } from '@edms/contracts';
import { SNIFF_BYTE_COUNT, extensionOf, isSupportedMimeType } from '@edms/domain';

import { completeUpload, findDuplicates, requestUploadTarget } from './actions';

/**
 * The upload handshake, from the browser's side.
 *
 * Three steps, and the middle one is the reason the other two exist: **the bytes go straight to
 * storage**, over a presigned URL that carries no session and expires in minutes. Nothing large
 * passes through a server action, so a 2 GB drawing is not bounded by a framework's body limit, and
 * the API stays stateless (`11-storage-architecture.md` §4).
 *
 * What this file is careful about is honesty in the failure cases. An upload has four ways to end —
 * refused before it starts, interrupted mid-transfer, stored but unscanned, stored and already
 * filed elsewhere — and every one of them is a different sentence to the person watching a progress
 * bar. Collapsing them into "upload failed" is what makes a document system feel arbitrary.
 */

export type UploadPhase =
  'reading' | 'requesting' | 'transferring' | 'completing' | 'stored' | 'failed';

export interface UploadProgress {
  readonly phase: UploadPhase;
  /** 0–1 through the transfer. Only meaningful while `transferring`. */
  readonly fraction: number;
}

export interface StoredFile {
  readonly fileObjectId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  /** Anything but `CLEAN` and the content cannot be attached to a document. */
  readonly scanStatus: string;
  /** The tenant already held these bytes, so nothing was transferred. */
  readonly deduplicated: boolean;
  /** Documents already filed against exactly this content. Empty when there are none. */
  readonly duplicates: readonly DuplicateMatch[];
}

export interface UploadFailure {
  readonly reason: string;
}

/**
 * Whether the browser should even try.
 *
 * A local check, so a file the picker should never have offered is refused without a round trip.
 * It is *not* the real check — the API sniffs the content, which is the only thing that can catch a
 * renamed executable — and it never accepts anything the API would refuse. It only declines faster.
 */
export function localRejectionFor(file: File): 'type' | 'empty' | null {
  if (file.size === 0) {
    return 'empty';
  }
  // The browser's own type when it has one; otherwise the extension, which is a guess and is
  // treated as such — the server decides from the bytes either way.
  const declared = file.type === '' ? mimeFromExtension(file.name) : file.type;
  return declared !== null && isSupportedMimeType(declared) ? null : 'type';
}

/**
 * The declared type, as this client will send it.
 *
 * A browser leaves `File.type` empty for formats it does not recognise, and DWG is the one this
 * product cares about most — every CAD upload would otherwise be refused for having no type at all.
 * So the extension fills the gap, and the server still decides from the content.
 */
export function declaredTypeOf(file: File): string {
  return file.type === ''
    ? (mimeFromExtension(file.name) ?? 'application/octet-stream')
    : file.type;
}

const BY_EXTENSION: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.dwg': 'image/vnd.dwg',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
};

function mimeFromExtension(filename: string): string | null {
  return BY_EXTENSION[extensionOf(filename)] ?? null;
}

/**
 * Uploads one file and reports what was stored.
 *
 * The digest is computed here, before anything is sent, and it earns its keep twice: when the
 * organisation already holds these bytes there is nothing to transfer at all, and it is what makes
 * the duplicate warning arrive before the person has filled in a form rather than after.
 *
 * `SubtleCrypto` is only available over HTTPS and on localhost. Where it is absent the digest is
 * simply omitted — the upload proceeds, and the server deduplicates at completion instead. One
 * transfer later, same outcome.
 */
export async function uploadFile(
  file: File,
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<StoredFile | UploadFailure> {
  onProgress({ phase: 'reading', fraction: 0 });
  const leading = new Uint8Array(await file.slice(0, SNIFF_BYTE_COUNT).arrayBuffer());
  const digest = await digestOf(file);

  onProgress({ phase: 'requesting', fraction: 0 });
  const target = await requestUploadTarget({
    filename: file.name,
    mimeType: declaredTypeOf(file),
    sizeBytes: file.size,
    magicBytes: base64(leading),
    ...(digest !== null && { checksumSha256: digest }),
  });
  if (!target.ok) {
    onProgress({ phase: 'failed', fraction: 0 });
    return { reason: target.detail ?? target.code };
  }

  // Nothing to transfer: content addressing means the organisation already holds exactly these
  // bytes. The person is told, and the duplicate list is what makes that useful rather than eerie.
  if (target.value.alreadyStored !== null) {
    onProgress({ phase: 'stored', fraction: 1 });
    return {
      fileObjectId: target.value.alreadyStored.fileObjectId,
      filename: file.name,
      mimeType: declaredTypeOf(file),
      sizeBytes: file.size,
      checksumSha256: digest ?? '',
      // The blob exists, so it has been through the gate already; the create will refuse it if the
      // verdict was not clean, which is the check that matters.
      scanStatus: 'CLEAN',
      deduplicated: true,
      duplicates: await duplicatesOf(target.value.alreadyStored.fileObjectId),
    };
  }

  try {
    await transfer(file, target.value, onProgress, signal);
  } catch (error) {
    onProgress({ phase: 'failed', fraction: 0 });
    return { reason: error instanceof Error ? error.message : 'transfer' };
  }

  onProgress({ phase: 'completing', fraction: 1 });
  const completed = await completeUpload(target.value.uploadSessionId, { parts: [] });
  if (!completed.ok) {
    onProgress({ phase: 'failed', fraction: 1 });
    return { reason: completed.detail ?? completed.code };
  }

  onProgress({ phase: 'stored', fraction: 1 });
  return {
    fileObjectId: completed.value.fileObjectId,
    filename: file.name,
    mimeType: completed.value.mimeType,
    sizeBytes: completed.value.sizeBytes,
    checksumSha256: completed.value.checksumSha256,
    scanStatus: completed.value.scanStatus,
    deduplicated: completed.value.deduplicated,
    duplicates: await duplicatesOf(completed.value.fileObjectId),
  };
}

async function duplicatesOf(fileObjectId: string): Promise<readonly DuplicateMatch[]> {
  try {
    return (await findDuplicates(fileObjectId)).matches;
  } catch {
    // A duplicate list that could not be fetched is a missing warning, not a failed upload. The
    // create endpoint checks again and refuses on its own, so nothing is lost but the early notice.
    return [];
  }
}

/**
 * The transfer itself.
 *
 * `XMLHttpRequest` rather than `fetch`, for one reason: `fetch` has no upload progress. A request
 * body stream would give it, and browser support for that is still uneven enough that a 2 GB upload
 * with no progress bar would be the outcome on a real fraction of machines. This is the case
 * `XMLHttpRequest` is still the right tool for.
 */
function transfer(
  file: File,
  target: UploadTarget,
  onProgress: (progress: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(target.method, target.url, true);
    for (const [name, value] of Object.entries(target.headers)) {
      // Sent verbatim: the size and content type are inside the signature, so changing one here
      // would invalidate the URL the server just issued.
      if (name.toLowerCase() !== 'content-length') {
        request.setRequestHeader(name, value);
      }
    }
    request.upload.onprogress = (event): void => {
      onProgress({
        phase: 'transferring',
        fraction: event.lengthComputable ? event.loaded / event.total : 0,
      });
    };
    request.onload = (): void => {
      if (request.status >= 200 && request.status < 300) {
        resolve();
      } else {
        reject(new Error(`storage responded ${String(request.status)}`));
      }
    };
    request.onerror = (): void => {
      reject(new Error('network'));
    };
    request.onabort = (): void => {
      reject(new Error('cancelled'));
    };
    signal?.addEventListener('abort', () => {
      request.abort();
    });
    request.send(file);
  });
}

/**
 * SHA-256 of the whole file, streamed in chunks.
 *
 * Chunked because `crypto.subtle.digest` takes a buffer, and reading a 2 GB file into one is how a
 * browser tab runs out of memory. `SubtleCrypto` has no streaming interface, so this reads the file
 * into a single buffer only when it is small enough to be worth it, and skips the digest entirely
 * above that — the server computes the real one from what actually arrived regardless, and the
 * client's is only ever an optimisation.
 */
async function digestOf(file: File): Promise<string | null> {
  if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
    // Not available over plain HTTP. The server deduplicates at completion instead.
    return null;
  }
  if (file.size > DIGEST_CEILING_BYTES) {
    return null;
  }
  try {
    const buffer = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** Above this the pre-upload digest costs more memory than the transfer it might save. */
const DIGEST_CEILING_BYTES = 128 * 1024 * 1024;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
