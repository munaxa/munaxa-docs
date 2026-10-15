import { ForbiddenError } from '../../../core/errors/application-errors';
import type { DocumentConfiguration } from './configuration.port';

/**
 * A confidentiality level that forbids download refuses it — whoever asks, and however.
 *
 * A level subtracts and never grants: holding `document:download` is not enough if the document's
 * own classification forbids it (`08-permission-model.md` §4). One function, so the single
 * download, a bulk export's per-document decision and a bulk export's links ask the same question
 * the same way; the bulk route once asked only the ACL and released documents whose level forbade
 * it (`docs/reports/hetzner-export-verified-delivery-design.md`, E-1).
 */
export async function refuseWhereLevelForbidsDownload(
  configuration: DocumentConfiguration,
  confidentialityId: string,
): Promise<void> {
  const level = await configuration.confidentiality(confidentialityId);
  if (level !== null && !level.allowDownload) {
    throw new ForbiddenError('download this document');
  }
}
