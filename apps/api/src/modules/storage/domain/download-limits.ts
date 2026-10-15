import { formatBytes } from './upload-policy';

/**
 * What the deployment's limits allow to exist that a download cannot verify — the export design
 * §6, decision D-7.
 *
 * A verified download reads the whole object into staging and refuses one larger than
 * `DOWNLOAD_MAX_FILE_BYTES` (`DOWNLOAD_TOO_LARGE`); there is deliberately no unverified fallback.
 * At the shipped defaults nothing reaches that limit. A deployment that raises an upload or export
 * ceiling past it can create files nobody can download, so this says so when the process starts,
 * naming the setting to raise together with `DOWNLOAD_STAGING_MAX_BYTES` (the file limit may not
 * exceed it). The screens also mark each such file "too large" rather than offering a button that
 * fails.
 */

/**
 * Bytes per row a report export can reach at most, for this estimate: the widest report (12
 * columns, titles to 200 characters, folder paths unbounded) in SpreadsheetML, which adds markup to
 * every cell. Deliberately generous — a warning that fires early is cheap; one that never fires
 * is not a warning.
 */
export const REPORT_ROW_BYTES_BOUND = 4_096;

export interface DownloadLimitInputs {
  readonly maxFileBytes: number;
  readonly maxUploadBytes: number;
  /** The antivirus driver: under `ICAP` an upload is capped at what the scanner is sent. */
  readonly antivirus: string;
  readonly icapMaxBytes: number;
  readonly reportMaxRows: number;
}

export function downloadLimitWarnings(inputs: DownloadLimitInputs): readonly string[] {
  const warnings: string[] = [];
  const limit = formatBytes(inputs.maxFileBytes);
  const upload =
    inputs.antivirus === 'ICAP'
      ? Math.min(inputs.maxUploadBytes, inputs.icapMaxBytes)
      : inputs.maxUploadBytes;
  if (upload > inputs.maxFileBytes) {
    warnings.push(
      `Documents up to ${formatBytes(upload)} can be uploaded, but a download is verified only up ` +
        `to ${limit} (DOWNLOAD_MAX_FILE_BYTES); larger files cannot be downloaded. Raise ` +
        'DOWNLOAD_MAX_FILE_BYTES with DOWNLOAD_STAGING_MAX_BYTES, or lower the upload ceiling.',
    );
  }
  const report = inputs.reportMaxRows * REPORT_ROW_BYTES_BOUND;
  if (report > inputs.maxFileBytes) {
    warnings.push(
      `A report export of ${String(inputs.reportMaxRows)} rows (REPORTING_EXPORT_MAX_ROWS) can ` +
        `reach about ${formatBytes(report)}, over the ${limit} a download is verified at; such an ` +
        'export is marked too large to download. Raise DOWNLOAD_MAX_FILE_BYTES with ' +
        'DOWNLOAD_STAGING_MAX_BYTES, or lower REPORTING_EXPORT_MAX_ROWS.',
    );
  }
  return warnings;
}
