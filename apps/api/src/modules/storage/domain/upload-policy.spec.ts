import { describe, expect, it } from 'vitest';

import { FileFormatFamily } from '@edms/domain';

import {
  type UploadCandidate,
  checkUpload,
  defaultUploadPolicy,
  formatBytes,
  isRejection,
  narrowPolicy,
} from './upload-policy';

const GIGABYTE = 1024 * 1024 * 1024;
const POLICY = defaultUploadPolicy(2 * GIGABYTE);

function bytes(...leading: number[]): Uint8Array {
  const buffer = new Uint8Array(32);
  buffer.set(leading);
  return buffer;
}

const PDF_BYTES = bytes(0x25, 0x50, 0x44, 0x46, 0x2d);
const PNG_BYTES = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const ZIP_BYTES = bytes(0x50, 0x4b, 0x03, 0x04);

function candidate(overrides: Partial<UploadCandidate> = {}): UploadCandidate {
  return {
    filename: 'QA-014 Procedure.pdf',
    declaredMimeType: 'application/pdf',
    sizeBytes: 40_960,
    magicBytes: PDF_BYTES,
    ...overrides,
  };
}

describe('an upload is accepted when', () => {
  it('the bytes are what the declaration says they are', () => {
    const result = checkUpload(candidate(), POLICY);
    expect(isRejection(result)).toBe(false);
    expect(!isRejection(result) && result.format.mimeType).toBe('application/pdf');
  });

  it('it is an office document, which is a ZIP and therefore needs the archive limits', () => {
    const result = checkUpload(
      candidate({
        filename: 'Register.xlsx',
        declaredMimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        magicBytes: ZIP_BYTES,
      }),
      POLICY,
    );
    // A `.docx` bomb is a `.zip` bomb with a different extension, so the limits are not for
    // archives-the-user-called-archives.
    expect(!isRejection(result) && result.requiresArchiveLimits).toBe(true);
  });

  it('it is a drawing at the deployment ceiling, which is what drawings weigh', () => {
    const result = checkUpload(
      candidate({
        filename: 'Site plan.dwg',
        declaredMimeType: 'image/vnd.dwg',
        magicBytes: bytes(0x41, 0x43, 0x31, 0x30, 0x33, 0x32),
        sizeBytes: 900 * 1024 * 1024,
      }),
      POLICY,
    );
    expect(isRejection(result)).toBe(false);
  });
});

describe('an upload is refused when', () => {
  it('it is empty — every empty file has the same digest', () => {
    // Content addressing makes this specific rather than fussy: zero bytes hash to one value, so
    // every empty upload in a tenant would deduplicate into one blob that many documents claim.
    const result = checkUpload(candidate({ sizeBytes: 0 }), POLICY);
    expect(isRejection(result) && result.reason).toBe('EMPTY');
  });

  it('the declared type is not one this product stores', () => {
    const result = checkUpload(
      candidate({ declaredMimeType: 'application/x-msdownload', magicBytes: bytes(0x4d, 0x5a) }),
      POLICY,
    );
    expect(isRejection(result) && result.reason).toBe('TYPE_NOT_ALLOWED');
  });

  it('an executable is renamed to a PDF', () => {
    const result = checkUpload(candidate({ magicBytes: bytes(0x4d, 0x5a, 0x90, 0x00) }), POLICY);
    expect(isRejection(result) && result.reason).toBe('TYPE_MISMATCH');
  });

  it('the bytes are a supported format, but not the declared one', () => {
    const result = checkUpload(candidate({ magicBytes: PNG_BYTES }), POLICY);
    expect(isRejection(result) && result.reason).toBe('TYPE_MISMATCH');
    // The message says what it *is*, because that is something the person can act on.
    expect(isRejection(result) && result.detail).toContain('PNG');
  });

  it('it exceeds its family ceiling, even though it is under the deployment one', () => {
    const result = checkUpload(
      candidate({
        filename: 'export.txt',
        declaredMimeType: 'text/plain',
        magicBytes: new TextEncoder().encode('id,name\n1,a\n'),
        sizeBytes: 64 * 1024 * 1024,
      }),
      POLICY,
    );
    expect(isRejection(result) && result.reason).toBe('TOO_LARGE');
    expect(isRejection(result) && result.detail).toContain('32 MB');
  });

  it('it has no usable name', () => {
    for (const filename of ['', '   ', 'x'.repeat(256)]) {
      const result = checkUpload(candidate({ filename }), POLICY);
      expect(isRejection(result) && result.reason).toBe('FILENAME_UNUSABLE');
    }
  });
});

describe('the checks run in the order the architecture specifies', () => {
  it('refuses an unsupported type before it looks at the bytes at all', () => {
    // Order matters because the allow-list decides what a sniff is permitted to conclude. A
    // genuine ELF binary declared as one must be refused as an unsupported *type*, not described.
    const result = checkUpload(
      candidate({
        declaredMimeType: 'application/x-executable',
        magicBytes: bytes(0x7f, 0x45, 0x4c, 0x46),
        sizeBytes: 8 * GIGABYTE,
      }),
      POLICY,
    );
    expect(isRejection(result) && result.reason).toBe('TYPE_NOT_ALLOWED');
  });

  it('refuses a mismatched type before it applies a size ceiling', () => {
    // Nothing is stored to find out it is refused, and the cheaper question is asked first.
    const result = checkUpload(
      candidate({ magicBytes: PNG_BYTES, sizeBytes: 8 * GIGABYTE }),
      POLICY,
    );
    expect(isRejection(result) && result.reason).toBe('TYPE_MISMATCH');
  });

  it('refuses an empty file before anything else, whatever it claims to be', () => {
    const result = checkUpload(
      candidate({ declaredMimeType: 'application/x-msdownload', sizeBytes: 0 }),
      POLICY,
    );
    expect(isRejection(result) && result.reason).toBe('EMPTY');
  });
});

describe('a tenant may narrow the policy and never widen it', () => {
  it('drops formats the tenant excluded', () => {
    const narrowed = narrowPolicy(POLICY, { allowedMimeTypes: ['application/pdf'] });
    expect(isRejection(checkUpload(candidate(), narrowed))).toBe(false);
    expect(
      isRejection(
        checkUpload(
          candidate({ filename: 'x.png', declaredMimeType: 'image/png', magicBytes: PNG_BYTES }),
          narrowed,
        ),
      ),
    ).toBe(true);
  });

  it('cannot introduce a format the product has no sniffer for', () => {
    const narrowed = narrowPolicy(POLICY, {
      allowedMimeTypes: ['application/pdf', 'application/x-msdownload'],
    });
    expect(narrowed.allowedMimeTypes).toEqual(['application/pdf']);
  });

  it('takes the smaller of the two ceilings, never the tenant’s if it is larger', () => {
    const narrowed = narrowPolicy(POLICY, { maxBytes: 5 * GIGABYTE });
    expect(narrowed.maxBytesDefault).toBe(POLICY.maxBytesDefault);
    expect(narrowed.maxBytesByFamily[FileFormatFamily.DRAWING]).toBe(POLICY.maxBytesDefault);
  });

  it('lowers every family ceiling that was above the new one', () => {
    const narrowed = narrowPolicy(POLICY, { maxBytes: 8 * 1024 * 1024 });
    expect(narrowed.maxBytesByFamily[FileFormatFamily.PDF]).toBe(8 * 1024 * 1024);
    // A family already below the new ceiling keeps its own, lower one.
    expect(narrowed.maxBytesByFamily[FileFormatFamily.TEXT]).toBe(8 * 1024 * 1024);
  });
});

describe('formatBytes', () => {
  it('says sizes the way a person would', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(32 * 1024 * 1024)).toBe('32 MB');
    expect(formatBytes(2 * GIGABYTE)).toBe('2.0 GB');
  });
});
