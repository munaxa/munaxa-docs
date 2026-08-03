import { randomBytes, randomUUID } from 'node:crypto';

/**
 * UUID v7 — a time-ordered identifier.
 *
 * Every primary key in the product is one. Ordering by generation time preserves B-tree
 * index locality (a random v4 scatters inserts across the whole index) while exposing no
 * sequence a client could enumerate.
 *
 * Layout, per RFC 9562 §5.7: 48 bits of Unix milliseconds, 4 version bits, 12 random bits,
 * 2 variant bits, 62 random bits.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(now);

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** A correlation identifier for one request or job. Not a key, so ordering is irrelevant. */
export function correlationId(): string {
  return randomUUID();
}
