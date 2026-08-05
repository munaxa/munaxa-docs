# ADR-0017 — A signature is a witnessed Part 11 attestation, not a qualified signature

- **Status:** Accepted
- **Date:** 2026-08-06
- **Phase:** 16

## Context

"Digital Signatures" is one line in the Phase 16 brief and it appears nowhere else in this
architecture: no table, no port, no ADR, no section in [03](../03-domain-model.md),
[06](../06-document-lifecycle.md) or [17](../17-security-architecture.md), and no action in
[13 §2](../13-audit-architecture.md). Every other capability in the phase had somewhere to look.
This one has to be decided before anything can be built, because the word means at least four
different things in a compliance product and they are not variations of each other — they have
different data models, different threat models, different regulatory weight and different costs.

**1. An approval record.** "Signed by" meaning "this person approved it in the workflow". Phase 4
already is this, completely: a decision, an actor, a timestamp, a comment, an audit event, a
delegation trail. Building a second one would give the product two answers to "who approved this".

**2. A cryptographic signature over the bytes.** A digest of the content, signed, so that later
tampering is detectable. Phase 9's `signManifest` and the audit checkpoint store are the existing
precedent, and they work: an HMAC over an exact serialisation, verified in constant time, kept where
the database cannot reach it.

**3. A drawn image stamped onto a rendition.** A picture of somebody's handwriting composited into
the served PDF. This is what most document systems mean, and it is the weakest of the four: an
image is copyable, proves nothing about who applied it, and is indistinguishable from one somebody
pasted. Phase 7's watermark already owns the "burn something into the rendition" mechanism.

**4. A qualified electronic signature.** eIDAS: a certificate from a trust-service provider, a
private key under the signer's sole control, a signature format (PAdES, XAdES) with long-term
validation data. This is the strongest and it is not reachable — it needs a CA relationship, key
material this product must never hold, and a signing library. The sandbox cannot add a dependency,
but that is not why it is refused: it is refused because a product that held its users' signing
keys would not be producing qualified signatures anyway.

The regulated customers this product is for do not, in fact, mostly need reading 4. They need
**21 CFR Part 11 subpart C** and its ISO 13485 / EU Annex 11 analogues, which ask for something
specific and achievable:

- §11.50 — the signed record shows the signer's **printed name**, the **date and time**, and the
  **meaning** of the signature.
- §11.70 — the signature is **linked to its record** so it cannot be excised and reapplied
  elsewhere.
- §11.200 — the signature uses at least **two distinct identification components**, and a signer
  re-authenticates when they are not in a continuous signing session.

## Decision

**A signature in Munaxa Docs is reading 2 in service of the Part 11 requirements, and is described
as an *electronic signature*, never as a qualified or digital one.**

1. **`document_signature` is a row per signature**, holding the signer, the purpose, the instant,
   the exact statement that was signed, and the server's witness over it. Not a `signed_by` /
   `signed_at` pair on `document_revision`: that would make two signatories with different meanings,
   a witness signature over somebody else's, and a dated attributed withdrawal all unrepresentable,
   and all three are ordinary in a controlled-document regime.

2. **The signed bytes are a canonical statement**, `serialiseSignatureStatement` in
   `@edms/domain` — versioned by its first line, field-ordered, newline-delimited — carrying the
   tenant, the document, its number, the revision and label, the **content SHA-256**, the signer's
   identifier, **printed name and email as they stood at that instant**, the purpose, the signer's
   own words and the timestamp. The tenant is in the bytes because a digest is not unique across
   tenants; the content digest is in the bytes because §11.70 is exactly that link; the printed name
   is in the bytes because §11.50 requires it and because a person who changes their name next year
   must not retroactively change what the record says was signed.

3. **The statement is stored verbatim** in `statement_body` and verification hashes *those* bytes
   rather than rebuilding them. Phase 9 established this for its evidence manifest and the reasoning
   is unchanged: a verification that reconstructs its own input depends on today's code producing
   the same string as the code that signed, which is a property of a release rather than of a
   signature.

4. **The witness is the server**, HMAC-SHA256 under a named `key_id`, the same construction as the
   audit checkpoints. The key identifier is on the row so a rotation is survivable — an old
   signature verifies against the key that made it, and a verification whose key is gone reports
   *that* rather than reporting "invalid".

5. **`document:sign` is a new permission, seeded to no role — including the tenant administrator.**
   [08 §6](../08-permission-model.md)'s first deliberate row excludes approval from the tenant
   administrator because approval is a `T`, held by being assigned a task. A signature is an `S`,
   held by an ACL entry on the node somebody is accountable for. A signatory conferred by seniority
   is the failure mode an electronic-signature regime exists to prevent.

6. **Re-authentication is required by default** (`signature.requireReauthentication`), satisfying
   §11.200: the password again, plus the TOTP code when the signer has a confirmed authenticator
   from Phase 14. Whether a given signature actually required it is recorded **on that signature**,
   because the setting can change afterwards and what this signature demanded is a fact about this
   signature.

7. **A withdrawal is a row's own columns, not a delete and not a flag alone**: `withdrawn_at`,
   `withdrawn_by`, `withdrawn_reason`. "This signature was later withdrawn, by whom, why and when"
   is the question an inspection asks, and a boolean cannot answer it.

8. **`DOCUMENT_SIGNED` is added to [13 §2](../13-audit-architecture.md)**, filed under the Document
   group with the document as its subject. Argued rather than assumed: the alternative was to
   overload `APPROVED`, and that would make "which approvals were signed" unanswerable — which is
   the one question the whole capability exists to answer. It is filed on the *document* rather than
   under a new subject type because a signature is an act on a document and belongs on its timeline,
   unlike a bulk operation, which belongs on nobody's.

9. **Verification answers three booleans, not one**: `signatureValid` (the witness still verifies),
   `contentMatches` (the revision's file still has the digest that was signed) and `withdrawn`. They
   fail for entirely different reasons — a tampered row, a §11.70 finding, and somebody taking their
   approval back — and one `valid` flag would collapse all three.

## Consequences

**What this buys.** A signature that survives the database: an auditor handed `statement_body`, the
signature and the key can verify offline, without trusting this application, and the statement names
in plain text exactly what was attested. Content tampering is detectable independently of the audit
chain, by a second mechanism with a different failure mode. The Part 11 §11.50 manifestation is
complete and queryable rather than a free-text field.

**What it costs, and this is the part to be honest about.** The witness is the *server's*, not the
signer's. Somebody with the witness key and write access to the database could forge a signature,
and no verification here would detect it. That is a genuinely weaker property than reading 4, and it
is why nothing in this product may call the result a qualified signature: the wire contract names
the witness rather than a certificate subject and has no field for one, and the UI says "signed"
rather than "digitally signed". The mitigations are the ones the audit trail already relies on —
the key lives outside the database it attests, and the `DOCUMENT_SIGNED` audit row is itself chained
— which makes forgery require two compromises rather than one, and that is the honest ceiling.

**What is deferred, and to whom.** Per-signer key material, a CA relationship, PAdES or XAdES
output, and long-term validation data are all reading 4 and are not this phase's. They are also not
a later phase's by default: adopting them is a *product* decision about becoming a party to a trust
framework, and the phase that takes it supersedes this ADR rather than editing it.

**What it does not change.** Phase 4's approval decisions are untouched and remain the record of who
approved what. A signature may be taken beside an approval — `purpose: APPROVAL` is exactly that —
and the two are separate rows because they are separate acts by separate authorities. Nothing in the
lifecycle requires a signature, and no transition consults one: making publication depend on a
signature would be a workflow change, and workflows are [ADR-0006](./0006-declarative-workflow-engine.md)'s
versioned data rather than code.
