'use server';

import {
  type ReportExport,
  type ReportExportLink,
  type ReportDefinition,
  requestExportBodySchema,
  saveReportDefinitionSchema,
} from '@edms/contracts';

import { type ActionResult, succeeded, toActionResult } from '../../lib/admin/action-result';
import { adminGet, adminWrite } from '../../lib/admin/api';
import { validated } from '../../lib/admin/validated';

/**
 * The reports screen's writes — and running a report is not one of them.
 *
 * Reading a report happens in the server component, as every read in this product does, with the
 * parameters in the URL. What a person *changes* here is only ever "queue an export", "hand me its
 * link", and "save these parameters" — and the first two leave a row in the trail, which is what
 * makes them writes in the sense that matters.
 *
 * Requesting an export is a `POST` because it creates a job. Taking its link is a `POST` for the
 * reason the audit bundle's is: issuing a signed URL creates a capability that outlives the request
 * and can be redeemed by whoever holds it, and Storage records the issuance as `FILE_DOWNLOAD_ISSUED`.
 */

export async function requestReportExport(
  key: string,
  input: unknown,
): Promise<ActionResult<ReportExport>> {
  return validated(requestExportBodySchema, input, (body) =>
    adminWrite<ReportExport>({ path: `/reports/${key}/exports`, method: 'POST', body }),
  );
}

/**
 * The signed URL for a completed export.
 *
 * A `GET` on the API, because it creates no job — but a server *action* here rather than an anchor
 * in the page, because the access token lives in an `httpOnly` cookie and never reaches client
 * JavaScript (16 §4). The browser follows the URL this returns; it never sees the session. The API
 * re-checks the report's full permission set before signing, so a link that stayed on screen after
 * a grant was withdrawn stops working rather than continuing to serve.
 */
export async function downloadReportExport(id: string): Promise<ActionResult<ReportExportLink>> {
  try {
    return succeeded(await adminGet<ReportExportLink>(`/reports/exports/${id}/download`));
  } catch (error) {
    return toActionResult<ReportExportLink>(error);
  }
}

export async function saveReportDefinition(
  input: unknown,
): Promise<ActionResult<ReportDefinition>> {
  return validated(saveReportDefinitionSchema, input, (body) =>
    adminWrite<ReportDefinition>({ path: '/reports/definitions', method: 'POST', body }),
  );
}

export async function deleteReportDefinition(id: string): Promise<ActionResult<void>> {
  return adminWrite<void>({ path: `/reports/definitions/${id}`, method: 'DELETE' });
}
