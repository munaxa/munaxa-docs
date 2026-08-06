# ADR-0020 — The deployment's secret store is the key management service; what the product owes is rotation

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 18

## Context

Phase 14 sealed the TOTP secret at rest and left a row in its report:

> | **The TOTP secret is sealed with a key derived from the signing secret** | 05 has no
> column-encryption facility, and adding one for a single column is wider than this phase warrants.
> It defends a database disclosure, not a compromised application | Phase 18, with a key management
> service |

Read literally, that names an integration: a `KEY_MANAGEMENT_PORT`, an adapter per provider — AWS
KMS, Azure Key Vault, GCP KMS, HashiCorp Vault — and configuration to choose one. Phase 18 is the
phase that owns the row, and the first thing it had to decide is whether that reading is right.

It is not, and the reason is what the product actually holds. There are four secrets:

| Secret | What it protects | Rotation costs |
| --- | --- | --- |
| `JWT_ACCESS_SECRET` | Access tokens, and the `LOCAL` driver's transfer capabilities | Every live session ends. Minutes |
| `AUDIT_CHECKPOINT_SECRET` | The signature on a daily audit checkpoint | Old checkpoints stop verifying under the new key |
| `SIGNATURE_WITNESS_SECRET` | The server's witness on a Part 11 signature | **Seven years.** A signature must verify for as long as the record is retained |
| The TOTP sealing key | Authenticator secrets at rest | Nothing visible, *if* rotation is possible at all |

Three of those four already come from the deployment's own secret material and always have. Adding
a port would not change where any of them lives; it would add an abstraction whose one adapter reads
an environment variable, in front of a boundary the platform already owns.

## Decision

**The deployment's secret store is the key management service.** This product does not integrate
with one, does not name one, and does not have a port for one. A KMS, a sealed secret, a mounted
file, a vault agent's sidecar and — on a single on-premise server — an environment file with `0600`
on it are all the same thing from here: material that arrives in the process's environment, rotates
without a code change, and is never logged. That is 20 §3's contract and it has been true since
Phase 0.5.

What the product owes instead, and what Phase 18 built, is the three properties that make an
external store *usable*:

**1. One key, one purpose.** `MFA_TOTP_SEALING_KEY` is its own secret rather than a derivation from
`JWT_ACCESS_SECRET`. Phase 14's derivation was careful — a domain-separated SHA-256, precisely so
one string was not doing two cryptographic jobs — and it still left the two on **one rotation
clock**. Rotating the token secret is a routine act with a fifteen-minute blast radius; it also,
silently, made every enrolled authenticator in the deployment unreadable. Nothing in the code said
so and nothing would have failed until somebody tried to sign in.

**2. Every sealed value names the key that sealed it.** The stored format carries a version, both
keys unseal, and new seals use the current one. Without that, rotation is not a procedure — it is a
mass invalidation with a migration behind it that nobody can run, because the plaintext needed to
re-seal is only available at the moment its owner proves a code.

**3. Rotation is a documented procedure with a stated cost per key**, in
[`docs/operations/deployment.md`](../../operations/deployment.md) §4, because the four keys above do
not rotate on the same clock and treating them as interchangeable is how the expensive one gets
rolled by somebody following a quarterly checklist.

## How a TOTP rotation completes

Lazily, one person at a time, and this is the part that could not be done any other way.

A row is re-sealed **the next time its owner successfully proves a code**, inside the transaction
that records the success. That is the only moment in the system where the plaintext secret and a
proof of it exist together — a deploy-time pass would need every tenant's authenticator secrets
unsealed in one process at one moment, which is precisely the exposure sealing exists to prevent.

The consequences are stated rather than hidden:

- A rotation **never completes** for an account nobody signs into. That row stays readable under the
  old key for ever, so the old key cannot be discarded on a schedule — it is discarded when the
  operator is willing to force re-enrolment for whoever is left.
- Removing a key that rows are still sealed under produces an error naming
  `MFA_TOTP_SEALING_KEY` rather than a failed sign-in that looks like a wrong code. A tested
  behaviour, not an intention.
- `v1` — Phase 14's derived key — is readable for ever, which is what makes the upgrade to this
  version a deploy rather than a migration. A deployment that sets no dedicated key produces
  byte-identical ciphertext to what it produced before.

## Alternatives considered

**A `KEY_MANAGEMENT_PORT` with adapters.** Refused on cost and on precedent. The cost is four
adapters, four sets of credentials, four failure modes and a network call in the sign-in path — a
KMS that is briefly unreachable would make every second factor in the deployment fail closed. The
precedent is this product's own: `STORAGE_PORT` exists because bytes genuinely live somewhere
different per deployment, and a *key* does not — it arrives in the environment either way.

**Envelope encryption with a data key per tenant.** The right answer for a product encrypting
customer content at the application layer, and this one does not: content is encrypted at rest by
the storage provider (17 §7), and the only application-layer sealing is one column. A per-tenant
data key would mean a key table, a wrapping key, a rotation path for both, and a new failure mode
where a tenant's data key is unavailable — bought for a single TOTP secret.

**Column encryption in PostgreSQL (`pgcrypto`).** It moves the key into the database's own reach,
which is exactly backwards: the property being bought is that a database disclosure does not carry
usable second factors, and a key the database can read is a key in the dump.

## Consequences

- Production refuses to boot without `MFA_TOTP_SEALING_KEY`, joining the checkpoint and witness
  secrets on that list.
- A development machine keeps Phase 14's derivation and behaves exactly as it did.
- The sealed format grows a version prefix, distinguishable structurally: Phase 14's format is three
  dot-separated base64 segments and base64 contains no dot, so a four-segment value is versioned.
  That is the lesson Phase 17 learned when its API-key separator turned out to be inside its own
  alphabet.
- **What this does not do** is defend against a compromised application. Anything that can read the
  sealing key can unseal the secrets, and it could mint access tokens directly. What it buys is
  unchanged from Phase 14: a backup, a replica, a dump handed to a support engineer or a `SELECT`
  through an injection carries no usable second factors — now with a rotation story behind it.
