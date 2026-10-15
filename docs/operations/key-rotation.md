# Key rotation and key loss

**Purpose:** how the three long-lived application keys are used, how each is rotated without losing
what it protects, and what happens — and what to do — when a rotation goes wrong or a key is lost.
**Audience:** operators. **Decision record:**
[ADR-0020](../architecture/adr/0020-key-management-and-rotation.md) and its 2026-10-15 amendment.
This page closes R-3, R-4 and the code half of R-5 in [the Hetzner readiness report](../reports/hetzner-test-deployment-readiness.md).

**No real key has been rotated** while preparing this page. Everything below marked *tested* is an
automated test against a real PostgreSQL database; nothing has been exercised on a live deployment.

## 1. The keys, what they protect, and where their use is recorded

| Key | Protects | Persisted as | Identifies its key by |
| --- | --- | --- | --- |
| `SIGNATURE_WITNESS_SECRET` | Electronic signatures (21 CFR Part 11 §11.70): an HMAC-SHA256 over the stored statement | `document_signature.signature`, `.key_id`, `.algorithm` | `key_id` = first 16 hex characters of SHA-256 of the key |
| `MFA_TOTP_SEALING_KEY` | Authenticator (TOTP) secrets at rest: AES-256-GCM | `mfa_enrolment.secret` as `v2.<nonce>.<ciphertext>.<tag>` (or Phase 14's three-part `v1`) | Nothing in the row; the GCM tag authenticates under exactly one key |
| `AUDIT_CHECKPOINT_SECRET` | Audit checkpoints in object storage (HMAC-SHA256), and evidence-bundle manifests | Checkpoint JSON under `audit/checkpoints/`; `manifest.sig` in a bundle | Nothing; each held key is tried |

`JWT_ACCESS_SECRET` is not covered: rotating it ends sessions and nothing else, **except** for
authenticator rows still in Phase 14's `v1` format, whose key is derived from it. A production
deployment always has `MFA_TOTP_SEALING_KEY`, and `v1` rows are re-sealed as `v2` the next time
their owner proves a code — so before rotating `JWT_ACCESS_SECRET` on a deployment that was ever
run without a sealing key, check that no `v1` row is left:
`SELECT count(*) FROM mfa_enrolment WHERE secret NOT LIKE 'v2.%';` (per tenant database, as
`edms_backup`).

## 2. How a rotation works

Each key has a **current** value and an optional list of **previous** values:

| Current | Previous (comma-separated) |
| --- | --- |
| `SIGNATURE_WITNESS_SECRET` | `SIGNATURE_WITNESS_PREVIOUS_SECRETS` |
| `MFA_TOTP_SEALING_KEY` | `MFA_TOTP_SEALING_PREVIOUS_KEYS` |
| `AUDIT_CHECKPOINT_SECRET` | `AUDIT_CHECKPOINT_PREVIOUS_SECRETS` |

- **New data is always written with the current value.** A previous value is only ever read with.
  *Tested:* a deployment holding a previous witness key still witnesses with the current one
  (`signature-statement.e2e.integration.spec.ts`), and a re-sealed authenticator opens with the new
  key alone and not with the old one (`mfa.integration.spec.ts`).
- **Old data stays readable** while its key is in the previous list:
  - a signature is verified with the key its `key_id` names — never by trying each key, so one key
    cannot vouch for a row another key witnessed (*tested*);
  - an authenticator row is opened by the first held key whose tag authenticates; the format is
    unchanged (`v2`), so a **rollback** to a build without previous-key support still reads every
    row sealed under the key that build is given (*tested*: mixed rows under the old and new key
    read side by side);
  - a checkpoint authenticates under any held key; a forged one still fails (*tested*).
- **The configuration refuses** a previous value without a current one, a previous value equal to
  the current one, the same value twice, a value shorter than 32 characters, and more than eight
  values. Its messages name the variable and never the value (*tested*,
  `configuration.spec.ts`).
- **An authenticator row no held key opens is never an error page.** Before this work, reading
  such a row threw, and the read that decides whether a factor is owed at sign-in is one of them —
  so a lost or dropped key locked its people out completely, recovery codes included. Now the
  authenticator code fails closed, a recovery code still proves the factor, and every refusal is
  audited with the reason `SEALING_KEY_NOT_HELD` (*tested*).
- **Re-sealing is lazy** for authenticators: a row moves to the new key inside the transaction that
  records its owner's next successful code (ADR-0020). Signatures are never re-witnessed — the
  witness is evidence of the act at the time, so a witness key is kept for the retention period of
  everything it signed. Checkpoints are not re-signed; new ones use the new key.

## 3. Procedure

Do this on TEST first. Keep the deployment's previous `api.env` until step 6 has passed.

1. **Generate** the new value: `openssl rand -hex 32` (no commas, no whitespace).
2. **Escrow it first** (§5): the new value must exist in the offline escrow before any data is
   written with it.
3. **Edit `api.env`:** append the current value to the matching previous list, then set the new
   value as current. Example for the witness key:
   `SIGNATURE_WITNESS_PREVIOUS_SECRETS=<old>` (or `<old>,<older>`) and
   `SIGNATURE_WITNESS_SECRET=<new>`.
4. **Restart the API** (`docker compose … up -d api`). A configuration error stops it at start-up
   and names the variable; fix and retry — nothing has been written.
5. **Check:**
   - signatures: verify one signature made before the rotation; it must report
     `signatureValid: true` and `witnessedBy: munaxa-docs:<old key id>`;
   - authenticators: a person enrolled before the rotation signs in with their code;
   - checkpoints: the next `audit.verify-chain` pass resumes from the last checkpoint rather than
     from genesis (its `fromSequence` is not 0).
6. **Keep** the previous value:
   - witness: for as long as any record it signed is retained;
   - checkpoint: for as long as the checkpoints and bundles it signed are kept as evidence;
   - MFA sealing: until no enrolment is sealed under it. Nothing reports that count yet (§6); keep
     it until every person who had an authenticator before the rotation has signed in since, or
     an administrator has reset the factor of everyone who has not.

### A failed rotation, and its recovery

The failure this design is built around is **replacing a key instead of moving it to the previous
list**. What happens, tested for each key:

| Key | Symptom | Data | Recovery |
| --- | --- | --- | --- |
| Witness | Old signatures verify `false`, `witnessedBy` ends `(key not held by this deployment)` | Unchanged | Put the old value in `SIGNATURE_WITNESS_PREVIOUS_SECRETS`, restart: they verify again |
| MFA sealing | People enrolled before the rotation have their authenticator codes refused (fail closed); each refusal is audited as `MFA_FAILED` with reason `SEALING_KEY_NOT_HELD` — alert on it (monitoring.md). Recovery codes still work, and the refused codes do not count toward the lock | **Unchanged** — nothing is re-sealed unless a key opened it | Put the old value in `MFA_TOTP_SEALING_PREVIOUS_KEYS`, restart |
| Checkpoint | The next verification pass starts further back (from genesis at worst); slower, not wrong | Unchanged | Put the old value in `AUDIT_CHECKPOINT_PREVIOUS_SECRETS`, restart |

**Rolling back a release** after a rotation: the previous release does not read the `*_PREVIOUS_*`
variables. Before rolling back across a rotation, either set the **old** value as current again
(everything sealed or signed with the new value since the rotation then needs the new value in the
previous list, which the old build cannot read — so prefer the next point), or roll back only to a
release that already supports previous values. In practice: do not rotate in the same window as a
release.

## 4. A lost key

"Lost" means no copy exists anywhere, escrow included. None of these is recoverable by software;
each is contained.

| Key lost | What breaks | What still holds | What to do |
| --- | --- | --- | --- |
| Witness | Signatures under it can no longer be shown to be the server's witness | The rows, the content digest check (`contentMatches`), and the audit trail's hash chain, which recorded each signing act | Set a new key (new signatures verify). Record an incident with the lost `key_id`; tell the affected tenants that signatures before the date are attested by the audit trail, not by the witness |
| MFA sealing | Everyone sealed under it cannot use their authenticator; the factor is still required (a lost key never switches MFA off) | Their recovery codes (hashed, independent of this key). *Tested:* sign in with one, remove the factor, enrol again under the new key | Set a new key and tell the affected people to use a recovery code. **Gap:** nobody can reset another person's factor in the product (removal is self-service only), so a person with no recovery code left needs their `mfa_enrolment` row deleted by an operator, as `edms_owner`, with the act recorded in the incident |
| Checkpoint | Checkpoints and bundle signatures under it cannot be authenticated | The hash chain itself: verification walks from genesis and still detects any alteration | Set a new key; run a full verification pass so a new checkpoint exists; record the lost checkpoint range |

## 5. Escrow (the code cannot do this part)

Losing a key is prevented only outside the application:

- Every value, current and previous, of the three keys is kept in **two** places that are not the
  server: the team password manager, and an encrypted offline copy (for example an `age`-encrypted
  file on removable media held by the owner).
- Escrow entries record the key's identifier and dates, never only the value:
  witness `key_id` (`printf %s "$KEY" | sha256sum | cut -c1-16`), and the date it became current and
  previous.
- The server's backup (`backup-and-restore.md`) deliberately does **not** contain `api.env`: a
  backup that held the keys would make a stolen backup decryptable and signable.
- Check the escrow at every quarterly restore test: restore TEST with keys taken **from the
  escrow**, not from the running server.

## 6. Not done, and why

- **No inventory of which enrolments are under which MFA key.** The row does not name the key, so
  counting needs the keys; a command that unseals every row in one process is exactly the exposure
  ADR-0020 refuses. Until one is designed, keep previous sealing keys (§3 step 6).
- **The evidence-bundle `manifest.sig` is checked outside the product**, with whichever checkpoint
  key was current when the bundle was made; record that in the escrow entry.
- Rotation has been tested in automated tests only, not on a running deployment.
