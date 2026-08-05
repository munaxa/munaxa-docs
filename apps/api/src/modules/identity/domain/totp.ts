import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 6238 time-based one-time passwords, and RFC 4648 base32 to carry the secret.
 *
 * ## Why this is written here rather than installed
 *
 * Not preference — constraint, and it is worth stating rather than leaving to be assumed. The
 * lockfile cannot gain a dependency in the environment this phase was built in, so an
 * authenticator library was not available. TOTP is the one second factor for which that is an
 * acceptable outcome: it is HMAC-SHA1 over a counter, `node:crypto` has HMAC-SHA1, and the whole
 * algorithm is the forty lines below with an RFC that specifies every one of them. **WebAuthn is
 * not**, which is why 17 §2's other half is deferred rather than hand-rolled — see the phase report.
 *
 * SHA-1 is the algorithm here, and that is correct rather than dated. RFC 6238 permits SHA-256 and
 * SHA-512, but every authenticator application in general use implements SHA-1 and most silently
 * fail on the others; HMAC-SHA1 is not affected by SHA-1's collision weaknesses, which are a
 * property of the hash used as a signature and not of its use as a MAC over a six-byte counter.
 *
 * ## What is *not* here
 *
 * Storage, clocks and policy. This file takes a secret, a counter and a code, and answers whether
 * they agree. Which secrets exist, how many attempts are allowed, and what "now" is all belong to
 * the service — because they are the parts a test needs to control and the parts that must not be
 * decided twice.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 160 bits, which is what RFC 4226 §4 recommends and what every authenticator expects. */
const SECRET_BYTES = 20;

/** A fresh base32 secret, for one enrolment. */
export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(SECRET_BYTES));
}

/**
 * The code for one time step.
 *
 * `step` is `floor(unixSeconds / stepSeconds)` — passed in rather than read here, because a
 * function that read the clock could not be tested at a boundary and the boundary is where the
 * skew window matters.
 */
export function totpCode(secret: string, step: number, digits: number): string {
  const key = decodeBase32(secret);
  const counter = Buffer.alloc(8);
  // The counter is 64-bit big-endian. `writeBigUInt64BE` rather than two 32-bit writes, because
  // the high half is only zero for the next few hundred million years and "only zero for now" is
  // how a clock bug becomes a lock-out.
  counter.writeBigUInt64BE(BigInt(Math.max(0, Math.trunc(step))));

  const digest = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte selects the offset.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Which time step a presented code belongs to, or null.
 *
 * Returns the **step** rather than a boolean, and that is the point: the caller records the step it
 * consumed so the same code cannot be replayed inside its own window. A boolean would make replay
 * protection impossible to express without re-deriving the step, which is the sort of duplication
 * that ends up subtly different.
 *
 * The comparison is `timingSafeEqual` over the whole candidate set. A short-circuiting `===` would
 * leak, through timing, which of the accepted steps matched — which is a narrow leak and a free one
 * to close.
 */
export function verifyTotp(
  secret: string,
  presented: string,
  options: {
    readonly step: number;
    readonly digits: number;
    /** How many steps either side of `step` are accepted. */
    readonly skewSteps: number;
  },
): number | null {
  const candidate = presented.trim().replaceAll(/\s/g, '');
  if (!new RegExp(`^\\d{${String(options.digits)}}$`).test(candidate)) {
    return null;
  }
  const presentedBytes = Buffer.from(candidate, 'utf8');

  let matched: number | null = null;
  for (let offset = -options.skewSteps; offset <= options.skewSteps; offset += 1) {
    const step = options.step + offset;
    const expected = Buffer.from(totpCode(secret, step, options.digits), 'utf8');
    if (
      expected.length === presentedBytes.length &&
      timingSafeEqual(expected, presentedBytes) &&
      matched === null
    ) {
      matched = step;
    }
  }
  return matched;
}

/**
 * The `otpauth://` URI an authenticator application scans.
 *
 * Built here rather than in the presentation layer because the label and issuer are part of what
 * the user will see in their authenticator for years, and getting the escaping wrong produces an
 * entry called `Munaxa%20Docs` that nobody can rename.
 */
export function totpUri(input: {
  readonly secret: string;
  readonly account: string;
  readonly issuer: string;
  readonly digits: number;
  readonly stepSeconds: number;
}): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const parameters = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(input.digits),
    period: String(input.stepSeconds),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/**
 * A recovery code: ten base32 characters in two groups, which is 50 bits of entropy.
 *
 * Base32 rather than hexadecimal because these are read off a screen and typed back in months
 * later, and the alphabet excludes `0`, `1`, `8` and `O`/`I`/`B` confusions by construction. The
 * hyphen is cosmetic and stripped before comparison, so somebody who types it or omits it is
 * equally right.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(8);
  const raw = encodeBase32(bytes).slice(0, 10);
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/** How a recovery code is compared: case and hyphens are presentation, not content. */
export function normalizeRecoveryCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z2-7]/g, '');
}

/**
 * The one place a recovery code becomes a stored value.
 *
 * SHA-256 rather than scrypt, which is the deliberate difference from `credential.password_hash`:
 * a recovery code is fifty bits of machine-generated entropy that nobody reuses anywhere, so the
 * offline-guessing attack scrypt's cost exists to slow does not apply — and a sign-in path that
 * spent scrypt once per stored code would be a denial of service on the account it protects.
 *
 * In the domain rather than in the repository because the *service* compares: the database returns
 * hashes and never decides. A hasher living in infrastructure would have to be reached from the
 * layer above it, which is the wrong direction and the lint says so.
 */
export function hashRecoveryCode(normalized: string): string {
  return createHash('sha256').update(`munaxa-docs:mfa-recovery:${normalized}`).digest('hex');
}

// --- base32 ---------------------------------------------------------------------------------

function encodeBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  // No padding. RFC 4648 permits `=` and every authenticator accepts its absence, while several
  // reject its presence in a QR payload.
  return output;
}

function decodeBase32(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of secret.toUpperCase().replaceAll('=', '')) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      // A character outside the alphabet means the stored secret is not a secret this code wrote.
      // Refusing loudly is right: silently skipping would decode to a *different* key and produce
      // a factor that never matches, which reads as "the user's phone is wrong".
      throw new Error('The stored authenticator secret is not valid base32.');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}
