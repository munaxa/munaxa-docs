import { describe, expect, it } from 'vitest';

import { downloadLimitWarnings } from './download-limits';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/** The shipped defaults: nothing a deployment can create is beyond what a download verifies. */
const DEFAULTS = {
  maxFileBytes: GIB,
  maxUploadBytes: 2 * GIB,
  antivirus: 'ICAP',
  icapMaxBytes: 128 * MIB,
  reportMaxRows: 250_000,
};

describe('the download limit warnings', () => {
  it('says nothing at the shipped defaults', () => {
    expect(downloadLimitWarnings(DEFAULTS)).toEqual([]);
  });

  it('warns when uploads can be larger than a download can verify', () => {
    const warnings = downloadLimitWarnings({ ...DEFAULTS, icapMaxBytes: 2 * GIB });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/DOWNLOAD_MAX_FILE_BYTES/u);
  });

  it('uses the full upload ceiling when no scanner caps it', () => {
    expect(downloadLimitWarnings({ ...DEFAULTS, antivirus: 'NONE' })).toHaveLength(1);
  });

  it('warns when the report row cap can produce an export larger than a download verifies', () => {
    const warnings = downloadLimitWarnings({ ...DEFAULTS, reportMaxRows: 5_000_000 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/REPORTING_EXPORT_MAX_ROWS/u);
  });

  it('warns when the download limit is lowered beneath what the defaults create', () => {
    expect(downloadLimitWarnings({ ...DEFAULTS, maxFileBytes: 64 * MIB })).toHaveLength(2);
  });
});
