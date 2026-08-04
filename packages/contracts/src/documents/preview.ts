import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from '../common/identifiers';

/**
 * Preview — what a document looks like without downloading it (`14-preview-architecture.md`).
 *
 * The manifest answers *whether and how*: what state rendering is in, how the viewer should
 * present the revision, and what the confidentiality level subtracts. The content response
 * carries a short-lived, single-artefact URL — issued per click, audited, and never a directory
 * a caller could walk. `PENDING` arrives with HTTP 202, the codebase's first: "not an error,
 * not an answer, ask again" is exactly what 202-with-status exists to say.
 */

export const previewStateSchema = z.enum(['PENDING', 'READY', 'FAILED', 'UNSUPPORTED']);

/** How the viewer should present the revision, given what the pipeline produced. */
export const previewModeSchema = z.enum(['PDF', 'IMAGE', 'TEXT']);

export const previewManifestSchema = z.object({
  revisionId: uuidSchema,
  state: previewStateSchema,
  /** Operator-readable when FAILED or UNSUPPORTED; null otherwise. */
  reason: z.string().nullable(),
  pageCount: z.number().int().nullable(),
  mode: previewModeSchema.nullable(),
  hasText: z.boolean(),
  /** Present when the text came off the pixels rather than out of the file. */
  ocr: z
    .object({
      engine: z.string(),
      /** 0–100, the engine's own scale. */
      confidence: z.number().int(),
      lowConfidence: z.boolean(),
    })
    .nullable(),
  /**
   * What the document's confidentiality level subtracts. The UI combines these with the
   * caller's own permissions; a level can forbid what a permission would allow, never the
   * reverse (`08-permission-model.md` §4).
   */
  confidentiality: z.object({
    downloadAllowed: z.boolean(),
    printAllowed: z.boolean(),
    watermark: z.boolean(),
  }),
});

export const previewContentSchema = z.object({
  state: previewStateSchema,
  reason: z.string().nullable(),
  /** The single-artefact URL. Null unless READY. */
  url: z.string().nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  contentType: z.string().nullable(),
  mode: z.enum(['PDF', 'IMAGE']).nullable(),
});

export const previewTextSchema = z.object({
  /** `TEXT` is the file's own words; `OCR` is an inference and the UI flags it. */
  source: z.enum(['TEXT', 'OCR']),
  lowConfidence: z.boolean(),
  pages: z.array(
    z.object({
      /** 1-based; null when the format has no pagination (plain text, a workbook). */
      page: z.number().int().nullable(),
      text: z.string(),
    }),
  ),
});

export type PreviewState = z.infer<typeof previewStateSchema>;
export type PreviewMode = z.infer<typeof previewModeSchema>;
export type PreviewManifest = z.infer<typeof previewManifestSchema>;
export type PreviewContent = z.infer<typeof previewContentSchema>;
export type PreviewText = z.infer<typeof previewTextSchema>;
