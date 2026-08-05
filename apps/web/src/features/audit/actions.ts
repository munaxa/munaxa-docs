'use server';

import {
  type AuditExport,
  type AuditExportDownload,
  auditExportRequestSchema,
} from '@edms/contracts';

import type { ActionResult } from '../../lib/admin/action-result';
import { adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * The audit screen's two writes.
 *
 * Reading the trail happens in the server component, as every read in this product does. What a
 * person *changes* here is only ever "produce an evidence bundle" and "hand me its links" — and
 * both are writes in the sense that matters: each leaves a row in the trail. The second is
 * especially not a read, which is why it is a `POST` on the API and an action here: issuing a
 * signed URL creates a capability that outlives the request, and the record of who was handed one
 * is the evidence of how a copy of the trail left the system.
 */

export async function requestAuditExport(input: unknown): Promise<ActionResult<AuditExport>> {
  return validated(auditExportRequestSchema, input, (body) =>
    adminWrite<AuditExport>({ path: '/audit/exports', method: 'POST', body }),
  );
}

export async function downloadAuditExport(id: string): Promise<ActionResult<AuditExportDownload>> {
  return adminWrite<AuditExportDownload>({
    path: `/audit/exports/${id}/download`,
    method: 'POST',
  });
}
