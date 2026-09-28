import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Settings } from '@edms/domain';

import {
  BULK_BODY_LIMIT_BYTES,
  BULK_ENVELOPE_BYTES,
  BULK_MAX_OBJECTS_CEILING,
  IDENTIFIER_BYTES,
} from './body-limits';

/**
 * The bulk body limit against the contracts it has to honour — RC validation, D-17.
 *
 * Measured on real JSON rather than on a formula: the bodies below are what a client would send at
 * the worst case each contract allows, so a change to the setting's ceiling, a field's maximum
 * length or the limit itself that breaks the relationship fails here rather than in production.
 */
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** A character that is three bytes in UTF-8 and not escaped by `JSON.stringify`. */
const WIDE = '€';

describe('the bulk body limit', () => {
  it('is bounded by a configured ceiling on bulk.maxObjects', () => {
    expect(Settings.BULK_MAX_OBJECTS.bounds?.max).toBeDefined();
    expect(Number.isFinite(BULK_MAX_OBJECTS_CEILING)).toBe(true);
  });

  it('reads an identifier list at the ceiling any administrator can configure', () => {
    const ids = Array.from({ length: BULK_MAX_OBJECTS_CEILING }, () => randomUUID());
    const listBytes = bytes(ids);
    // The per-identifier figure the module documents is the real one.
    // (Plus the array's two brackets; the last identifier has no comma.)
    expect(listBytes).toBeLessThanOrEqual(BULK_MAX_OBJECTS_CEILING * IDENTIFIER_BYTES + 2);
    // A metadata request: the list and an envelope of other fields, inside the limit.
    expect(listBytes + BULK_ENVELOPE_BYTES).toBeLessThanOrEqual(BULK_BODY_LIMIT_BYTES);
    const approval = bytes({ taskIds: ids, decision: 'APPROVED', comment: WIDE.repeat(2_000) });
    expect(approval).toBeLessThanOrEqual(BULK_BODY_LIMIT_BYTES);
  });

  it('reads a bulk upload at the default bulk.maxObjects with every name at its longest', () => {
    const file = () => ({
      fileObjectId: randomUUID(),
      // `bulkUploadSchema`: filename ≤ 255, title ≤ 200 (`nameSchema`).
      filename: WIDE.repeat(255),
      title: WIDE.repeat(200),
    });
    const body = {
      folderId: randomUUID(),
      documentTypeId: randomUUID(),
      categoryId: randomUUID(),
      confidentialityId: randomUUID(),
      files: Array.from({ length: Settings.BULK_MAX_OBJECTS.defaultValue }, file),
    };
    expect(bytes(body)).toBeLessThanOrEqual(BULK_BODY_LIMIT_BYTES);
  });

  it('stays a bound: far below anything that would make parsing a body a denial of service', () => {
    expect(BULK_BODY_LIMIT_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });
});
