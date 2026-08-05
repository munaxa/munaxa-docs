import { z } from 'zod';

import { pageQuerySchema } from '../common/pagination';

/**
 * Phase 9 — the audit surface (`docs/architecture/13-audit-architecture.md` §6).
 *
 * Three shapes, and each one carries a claim the API must not overstate.
 *
 * **An audit entry carries its digest *and* the version of the digest.** `chainHashVersion` is on
 * the wire rather than hidden behind the server, because it is what says how much the `hash` next
 * to it proves: rows written before this phase attest nine fields, rows written since attest every
 * column but the hashes themselves. A client showing "verified" beside a row is showing something
 * different in the two cases, and it can only know which from this field.
 *
 * **The search is structured, never free text.** Actor, action, subject, outcome, correlation id
 * and a date range — 13 §6's own list. There is deliberately no query box over `payload`: the
 * payload is minimised by §3 and searching it would be both a promise the index cannot keep and an
 * invitation to put more in it than that section allows.
 *
 * **An export is a job, and its bundle is a set of artefacts with digests.** The wire shape says so
 * rather than pretending a download is available immediately, because a seven-year range is not a
 * response body and an API that implied otherwise would time out on the range that matters most.
 */

export const auditOutcomeSchema = z.enum(['SUCCESS', 'DENIED', 'FAILED']);

export const auditSubjectTypeSchema = z.enum([
  'DOCUMENT',
  'REVISION',
  'FOLDER',
  'LIBRARY',
  'USER',
  'ROLE',
  'WORKFLOW',
  'TASK',
  'CONFIGURATION',
  'SESSION',
  'FILE',
  'SEARCH',
  'EXPORT',
]);

export type AuditSubjectTypeValue = z.infer<typeof auditSubjectTypeSchema>;

export interface AuditEntry {
  readonly id: string;
  /** Per-tenant, gap-free. A hole in a page of these is a deletion, not a filter. */
  readonly sequence: string;
  readonly occurredAt: string;
  readonly actorId: string | null;
  readonly onBehalfOfId: string | null;
  readonly channel: string;
  readonly action: string;
  readonly subjectType: AuditSubjectTypeValue;
  readonly subjectId: string;
  readonly outcome: z.infer<typeof auditOutcomeSchema>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly reason: string | null;
  readonly correlationId: string;
  readonly hash: string;
  readonly previousHash: string;
  /** Which field set the hash covers: `1` is the Phase 1 digest, `2` the widened one. */
  readonly chainHashVersion: number;
}

export interface AuditPage {
  readonly data: readonly AuditEntry[];
  readonly meta: { page: number; pageSize: number; total: number; hasMore: boolean };
}

/**
 * The audit search's query.
 *
 * `action` repeats rather than taking a comma-separated list, because "or" over a set is what a
 * repeated parameter already means in a query string and a delimiter would be one more thing a
 * value could legitimately contain.
 */
export const auditSearchQuerySchema = pageQuerySchema.extend({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  actorId: z.string().uuid().optional(),
  action: z
    .union([z.string().trim().min(1).max(80), z.array(z.string().trim().min(1).max(80))])
    .optional(),
  subjectType: auditSubjectTypeSchema.optional(),
  subjectId: z.string().uuid().optional(),
  outcome: auditOutcomeSchema.optional(),
  correlationId: z.string().trim().min(1).max(200).optional(),
});

export type AuditSearchQuery = z.infer<typeof auditSearchQuerySchema>;

/** The timeline's own query: a page, nothing else — the subject is in the path. */
export const auditTimelineQuerySchema = pageQuerySchema;

export type AuditTimelineQuery = z.infer<typeof auditTimelineQuerySchema>;

export const auditExportRequestSchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    action: z.string().trim().min(1).max(80).optional(),
    actorId: z.string().uuid().optional(),
    subjectType: auditSubjectTypeSchema.optional(),
    outcome: auditOutcomeSchema.optional(),
  })
  .refine((body) => Date.parse(body.from) <= Date.parse(body.to), {
    path: ['to'],
    message: 'The end of the range must not precede its start.',
  });

export type AuditExportRequestBody = z.infer<typeof auditExportRequestSchema>;

export interface AuditExportArtefactView {
  readonly name: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  /** The digest of the bytes as written — what the manifest asserts and a verifier recomputes. */
  readonly sha256: string;
}

export interface AuditExport {
  readonly id: string;
  readonly state: 'REQUESTED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  readonly from: string;
  readonly to: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly requestedById: string;
  readonly requestedAt: string;
  readonly eventCount: number;
  readonly artefacts: readonly AuditExportArtefactView[];
  /** Null until the run has verified the range; false is a finding, not a failure to produce. */
  readonly chainIntact: boolean | null;
  readonly completedAt: string | null;
  readonly error: string | null;
}

export interface AuditExportDownload {
  readonly data: readonly { name: string; url: string; expiresAt: string }[];
}

/** What the last verification pass established. The compliance screen's headline. */
export interface AuditChainStatus {
  readonly intact: boolean;
  readonly brokenAt: string | null;
  readonly reason: string | null;
  readonly eventsVerified: number;
  readonly fromSequence: string;
  readonly toSequence: string;
  /** False when the deployment records no signed checkpoint — the pass still ran. */
  readonly checkpointed: boolean;
}

/** The distinct actions present in this tenant's trail, for the search screen's filter. */
export interface AuditActions {
  readonly data: readonly string[];
}
