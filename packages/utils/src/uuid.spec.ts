import { describe, expect, it } from 'vitest';

import { isUuid, uuidv7 } from './uuid';

describe('uuidv7', () => {
  it('produces a well-formed version 7 uuid', () => {
    const value = uuidv7();
    expect(isUuid(value)).toBe(true);
    expect(value[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(value[19]);
  });

  it('sorts by generation time, which is the reason for choosing v7', () => {
    expect(uuidv7(1_700_000_000_000) < uuidv7(1_700_000_001_000)).toBe(true);
  });

  it('stays unique across a burst inside one millisecond', () => {
    const now = Date.now();
    expect(new Set(Array.from({ length: 2_000 }, () => uuidv7(now))).size).toBe(2_000);
  });
});
