import { z } from 'zod';

import { SUPPORTED_MIME_TYPES } from '@edms/domain';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';

/**
 * Uploads — the two-step handshake that keeps bytes out of the API.
 *
 * The client asks for a target, transfers the bytes straight to storage, then says it is done.
 * Nothing in this file carries content, and that is the contract rather than an omission: a 2 GB
 * upload must not occupy an application process, and the API stays stateless because it never held
 * the file (`11-storage-architecture.md` §4).
 */

/** Lower-case hexadecimal SHA-256. The only digest this product speaks. */
export const checksumSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{64}$/, 'A checksum is 64 hexadecimal characters.');

export const supportedMimeTypeSchema = z.enum(
  SUPPORTED_MIME_TYPES as unknown as [string, ...string[]],
);

/**
 * The leading bytes of the file, base64-encoded.
 *
 * The client sends them because the API never sees the file itself, and the type has to be
 * decided from content before a target is issued — an extension is a claim by whoever named the
 * file, and a `Content-Type` is a claim by whoever is uploading it.
 *
 * A client could of course send bytes that are not the file's. That is worth being precise about:
 * this check is not what makes storage safe on its own. It is the *first* gate, it costs nothing,
 * and it catches the overwhelmingly common case — somebody renaming a file to get past a filter.
 * The malware scan is what covers a client that lies deliberately, and the download path never
 * serves the original as anything but an attachment.
 *
 * Bounded at 1 kB: the deepest signature the product looks for is twelve bytes in.
 */
export const magicBytesSchema = z
  .string()
  .min(4)
  .max(1400)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'The leading bytes are base64.');

export const createUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  /** What the client says it is. Checked against the bytes, and stored only if they agree. */
  mimeType: supportedMimeTypeSchema,
  sizeBytes: z.number().int().positive(),
  magicBytes: magicBytesSchema,
  /**
   * The digest the client computed, if it did.
   *
   * Optional, and worth sending: when the tenant already holds these bytes the answer says so and
   * there is nothing to transfer. That is content addressing paying for itself, and it is also how
   * a duplicate is detected before an upload rather than after one.
   */
  checksumSha256: checksumSchema.optional(),
});

export const uploadPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  /** The entity tag the store returned for this part. The API never sees the bytes to compute it. */
  etag: z.string().trim().min(1).max(256),
});

export const completeUploadSchema = z.object({
  /** Empty for a single transfer; one entry per part for a resumable one. */
  parts: z.array(uploadPartSchema).max(10_000).default([]),
});

export const uploadTargetSchema = z.object({
  uploadSessionId: uuidSchema,
  /** Empty when `alreadyStored` is set: there is nothing to transfer. */
  url: z.string(),
  method: z.enum(['PUT', 'POST']),
  /** Send these verbatim. They are inside the signature, so changing one invalidates the URL. */
  headers: z.record(z.string()),
  expiresAt: isoDateTimeSchema,
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1), url: z.string().url() }))
    .nullable(),
  /** The tenant already holds these bytes. Skip the transfer and complete immediately. */
  alreadyStored: z.object({ fileObjectId: uuidSchema }).nullable(),
});

export const scanStatusSchema = z.enum(['PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED']);

export const completedUploadSchema = z.object({
  fileObjectId: uuidSchema,
  checksumSha256: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string(),
  /** Anything but `CLEAN` and the content is unreachable — it cannot be attached or downloaded. */
  scanStatus: scanStatusSchema,
  deduplicated: z.boolean(),
});

export type CreateUploadBody = z.infer<typeof createUploadSchema>;
export type CompleteUploadBody = z.infer<typeof completeUploadSchema>;
export type UploadTarget = z.infer<typeof uploadTargetSchema>;
export type CompletedUpload = z.infer<typeof completedUploadSchema>;
export type ScanStatus = z.infer<typeof scanStatusSchema>;
