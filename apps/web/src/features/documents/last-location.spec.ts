import { describe, expect, it } from 'vitest';

import { formatLastLocation, parseLastLocation } from './last-location';

const LIB = '019489f0-0000-7000-8000-000000000301';
const FOLDER = '019489f0-0000-7000-8000-000000000201';

describe('the remembered Documents location', () => {
  it('round-trips two identifiers', () => {
    const value = formatLastLocation({ libraryId: LIB, folderId: FOLDER });
    expect(value).toBe(`${LIB}.${FOLDER}`);
    expect(parseLastLocation(value ?? undefined)).toStrictEqual({
      libraryId: LIB,
      folderId: FOLDER,
    });
  });

  it.each([
    undefined,
    '',
    LIB,
    `${LIB}.${FOLDER}.${FOLDER}`,
    `${LIB}.not-a-folder`,
    `../admin.${FOLDER}`,
    `${LIB}.${FOLDER}&favorite=true`,
  ])('ignores %s', (value) => {
    expect(parseLastLocation(value)).toBeNull();
  });

  it('refuses to write anything that is not two identifiers', () => {
    expect(formatLastLocation({ libraryId: LIB, folderId: 'x' })).toBeNull();
    expect(formatLastLocation({ libraryId: 'a;b', folderId: FOLDER })).toBeNull();
  });
});
