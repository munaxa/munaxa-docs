import { z } from 'zod';

/** Primitive shapes reused by every contract, so "an id" means the same thing everywhere. */
export const uuidSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime();
export const isoDateSchema = z.string().date();

/** Optimistic concurrency token, sent back in `If-Match` on the next write. */
export const versionSchema = z.number().int().min(0);

/** The audit stamps every resource representation carries. */
export const auditStampSchema = z.object({
  createdAt: isoDateTimeSchema,
  createdBy: uuidSchema,
  updatedAt: isoDateTimeSchema,
  updatedBy: uuidSchema,
});

export type AuditStamp = z.infer<typeof auditStampSchema>;
