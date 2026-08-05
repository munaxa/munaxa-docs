# Phase 14 — Enterprise Security: what was built, what it costs, and what it deliberately does not do

**Status:** point-in-time record of the Enterprise Security phase. Historical — superseded, never revised.
**Audience:** whoever builds Phase 15 and after, and whoever audits what Phase 14 claimed.

This is the ACL phase. Six earlier phases deferred work to it by name, and
[08 §9](../architecture/08-permission-model.md) ended with a sentence written for it: *"The entries,
the walk, deny precedence, `@ScopedTo` on object routes, capabilities in responses and §8's cache
remain the ACL phase's — they extend this binding rather than replace anything that now calls it."*

All six arrived, and the extension held: **`PrismaAclResolver` keeps its four method signatures, and
not one caller of `ACL_RESOLVER` changed.** `AclGuard`, Phase 13's dashboard, search's query side,
search's projection, Phase 9's audit timeline and Phase 12's recipient walk all call exactly what
they called before and now get answers that depend on the object.

## 1. The entries, and the walk

`acl_entry` is the table [ADR-0005](../architecture/adr/0005-hierarchical-acl-with-deny-precedence.md)
has described since Phase 0 and nothing had. Steps 3–5 of 08 §3 have found nothing since Phase 8
bound the resolver, because what they read did not exist. They read it now, and the model is
unchanged: capability from `role_permission`, reach from `acl_entry`, both required.

Three properties are structural rather than validated:

- **`uq_acl_entry`** means one subject holds at most one effect per permission per node. `ALLOW` and
  `DENY` for the same triple cannot coexist, so the walk never breaks a tie *at* a node — every tie
  it resolves is between nodes, which is where deny-wins applies and where ADR-0005's "auditable by
  inspection" claim lives.
- **`scope_id` is never null.** A `TENANT` entry carries the tenant's own id, so the walk's
  `scope_id IN (…)` needs no special case for the root.
- **No `deleted_at`.** Every other tenant-scoped table has one; this deliberately does not. A revoked
  entry has no reader, and tombstones would put a `deleted_at IS NULL` on the hottest predicate in
  the product forever. The revocation's record is the `ACL_REVOKED` audit event, which is
  append-only, hash-chained and attests its own payload.

The decision itself is `library/domain/acl-walk.ts` — arithmetic over a chain that has already been
read. Keeping it pure is what lets ADR-0005's prose be asserted without a database, and what stops
the two call sites that must agree (a direct read, and the index's materialised subjects) from
becoming two implementations of one algorithm.

`PrismaScopeChainReader` assembles the chain. The honest accounting is **one query per level of the
tree that is a different table** — five at the very worst, for a document in a folder in a library
owned by a department — and never one per ancestor. That is the property ADR-0014's materialised
paths buy and the one that matters: a folder nested twenty deep costs what one nested two costs.

## 2. The decisions the specification left open

### 2.1 What "stops the walk" means — recorded as [ADR-0016](../architecture/adr/0016-inheritance-break-truncates-the-chain.md)

ADR-0005's fifth rule is one sentence and has two readings. Either a break stops *granting*, leaving
denies from above still in force, or it stops *resolving*, and the chain begins at the breaking
folder. Nothing had to choose until now, because `acl_entry` held no rows and `folder.inherit_acl`
had no reader.

**A break truncates the chain, for both effects**, including step 6's tenant-level role grant. The
alternative is more conservative in the sense that it can only ever subtract, and that is exactly why
it was rejected: it makes the flag a one-way valve whose behaviour an administrator cannot read off
the screen. "This folder does not inherit permissions" would be false, and the true statement — "this
folder does not inherit grants but does inherit refusals" — is not something a checkbox can say.

Deny-precedence stays what 08 §3 says it is: a rule about the entries on the chain. The break decides
what the chain *is*.

The consequence is the sharpest edge in the model: **a break with no entries beneath it hides its
subtree from everybody except administrators.** That is intended, it is audited, and it is why the
permissions screen renders the chain with the break marked whether or not anybody has asked about a
person.

### 2.2 How a relational list gets a predicate

08 §7 requires list endpoints to filter "by a permission predicate pushed into SQL — never
fetch-then-filter, which leaks totals, facet counts and page boundaries". The search index already
had a shape: two arrays of opaque subject tokens, compared by the engine (12 §3). A relational list
has no such column.

`VisibilityFilter` gained **regions** beside its subject tokens — a container the caller reaches
(the whole tenant, a set of libraries, a folder path, a set of documents) together with the folder
subtrees excluded from it because a break sits between its node and them. Both shapes come from
**one** resolution in one call, so a relational list and the index can no more disagree than the
index and a direct read can.

Two alternatives were weighed. **Materialising a fingerprint column on `document`** would make the
list predicate a single comparison, and it was rejected on invalidation: the index is allowed to lag
because a stale search result is corrected the moment somebody opens it, whereas a stale column on
`document` would be the *authoritative* answer, and an ACL change would have to rewrite every
affected row inside the administrator's transaction. **Raw SQL** would make
`prisma-document.repository.ts` the only place in the product where the scope tree is expressed in
SQL rather than through Prisma, with the walk stated a second time.

### 2.3 Where the predicate is applied, and why Phase 13's claim came true

Phase 13's report said its counts would inherit the ACL predicate "in the same commit and without
`dashboard.service.ts` changing", because they are built from the document list's own predicate. The
brief asked for that claim to be verified rather than assumed. **It is true, and it is true because
of where the predicate was put.**

`visibilityFilter` is consumed inside `PrismaDocumentRepository.whereFor` — the repository — rather
than in `DefaultDocumentService.list`. Putting it in the service would have filtered the list and
left every count beside it describing a different set of rows, which is exactly the divergence 08
§7's Query row exists to prevent, arriving through the one door nobody was watching.
`dashboard.service.ts` is unchanged.

### 2.4 Whether the resolver applies 08 §4's modifiers — it does not

08 §3's step 8 says "apply state and confidentiality rules; they can only subtract". The brief asked
whether the resolver should now do that, or whether they stay where Phase 6 and Phase 7 put them.

**They stay.** Folding them into `resolve` would make every refusal a `404`, because that is what
`AclGuard` produces — and "you may not print this document" would become "this document does not
exist" for somebody holding `document:print` who is looking at it. §4's modifiers subtract from what
an *act* may do; the resolver answers whether an *object* may be reached. `Decision.reason` keeps its
`STATE` and `CONFIDENTIALITY` members and no code path produces them, which documents a decision the
resolver deliberately does not make.

### 2.5 What an ACL change does to the search index

08 §8's harder half. `acl_subjects`, `acl_deny_subjects` and `acl_hash` are materialised per entry, so
a change high on the tree invalidates every index row beneath it. Three shapes were available.

A **lane message per document**, written by the producer, is impossible at the top of a tree: an entry
on a company would be a transaction enqueuing a hundred thousand rows inside an administrator's
request. A **full rebuild** is the wrong instrument twice over — it exists for a mapping change, it
takes minutes, and Phase 8 built it to *never empty a live index*, which is a guarantee about a
different problem.

So: a **targeted reprojection**. `library.acl-changed` and `library.folder-moved` route to
`search.index` — where neither routed before, because `library.*` matched no prefix, exactly as
`delegation.*` did not in Phase 11 — and a new job shape walks the affected subtree one page at a
time, each page enqueuing the next, with the cursor in the job so there is no state to resume.
Coalesced per node per debounce window, so an administrator saving a matrix three times reprojects
once.

**What the index serves in the meantime is the previous answer**, and that is worth stating plainly
because it is the only window in the product where the index and a direct read disagree. A newly
denied caller can, until the subtree is reprojected, see a title and a snippet in a result list.
Clicking it gets a `404`, because `AclGuard` asks the resolver rather than the index. Every other
surface — the document page, the folder listing, the dashboard count — is correct from the instant
the transaction commits. Widening that window is what a rebuild would have done.

An organisation node does not narrow to a document predicate in the search module — resolving a
department to its libraries would be a second implementation of `ScopeChainReader.librariesUnder` in
a module with no business knowing the organisation tree — so an entry on one logs that it reached no
index entry through that node rather than doing it quietly.

### 2.6 Whether MFA belongs in this phase — it does, as TOTP only

The brief named the question first: the Objective section is entirely about permissions and lists no
authentication factor, while 13 §2 attributes `MFA_ENROLLED`, `MFA_FAILED` and `SESSION_REVOKED` here
by name.

**Built, and the deciding argument is not the audit rows.** `user.mfa_enrolled` has existed since
Phase 1, read by the auth response and the admin view, and **written by nothing**. A boolean that has
answered "no" for thirteen phases whatever the truth was is not a missing feature; it is a fact the
product asserts and does not check, on the security surface, and leaving it that way for another
phase was not defensible once the phase named "Enterprise Security" had looked at it.

**TOTP only. WebAuthn is deferred to Phase 17**, and the two are not one decision. TOTP is HMAC-SHA1
over a counter, with an RFC that specifies every line and publishes test vectors; `node:crypto` has
HMAC-SHA1, and the implementation is asserted against RFC 6238's own vectors in
`domain/totp.spec.ts`. WebAuthn is CBOR, COSE key parsing, attestation statement formats and a
registry of authenticator metadata — none of which should be hand-written in a security product, and
none of which the sandbox could install. Shipping half the protocol badly would be worse than
shipping one protocol well.

**The policy half of 17 §2 is also deferred**, and this is the part worth arguing with. 17 §2 says
MFA is "required by policy for `TENANT_ADMIN`, `DOCUMENT_CONTROLLER` and `AUDITOR`; available to
all", and `role-admin.service.ts` already cites that policy as a reason those keys cannot be renamed.
What is built is the second half: anybody may enrol, and an enrolled account is challenged.
Enforcing the first half means refusing a sign-in from somebody who holds one of those roles and has
not enrolled — which, on the day it is switched on, locks out exactly the accounts that administer
the tenant, in a deployment where nobody has enrolled yet. That needs an operator-side way back in,
which is 17's federation work, and it is named there rather than done here badly.

### 2.7 What "Share" means — declined, with the reasoning

The brief's permission list names **Share**. It exists nowhere in the product: no permission in the
catalogue, no table, no endpoint, and 17's threat table has no row for it.

**This phase declines to build it**, and the reason is that the three plausible meanings are three
different features with three different disclosure consequences, and this phase can only make one of
them safe:

1. **An ACL entry with a shorter shape** — "share this document with Ada" — is already what
   `PUT /scopes/document/{id}/permissions` does. Adding a second, friendlier surface over the same
   table would be a second way to grant reach, with its own defaults, that the permissions screen
   would then have to explain. If Share means this, it is built, and what it needs is a nicer form.
2. **A signed link** — an unauthenticated URL that discloses a document — is a genuinely new
   capability and a new threat model: link forwarding, expiry, revocation, whether the recipient's
   view is audited and against whom, and what a legal hold means for a link already issued. None of
   those has a row in 17's threat table, and inventing them in a phase whose named risk is silently
   opening the product is the wrong place to guess.
3. **External identities** — sharing with somebody outside the tenant — is federation, which is
   17 §2's, and is out of this brief by its own statement.

**Owner: Phase 16** for reading (2) as an advanced feature with its own threat analysis, or **Phase
17** if it is read as (3). What is *not* deferred is the capability an administrator actually needs
today, which is (1), and it works.

### 2.8 Federation and OIDC/SAML — not here

Named in 17 §2 and not in this brief. They are not this phase's, and the reason is more than
scheduling: federation moves *authentication* out of the product, and every decision in this phase is
about *authorisation* over identities the product already holds. The one place they touch is the MFA
policy above, which is why that half went with them rather than staying here.

## 3. The named risk: this phase can silently open the product

Every phase before this was gated on "does this caller hold the tenant-level grant" — coarse, and
*closed*. Introducing entries introduces `ALLOW`, and an `ALLOW` on the wrong node reaches every
object beneath it.

Four things hold against it.

**The default direction never moved.** No entry and no grant is still a refusal, and the seed grants
nothing new: the matrix's `S` rows became *expressible* in this phase, not *granted*. Changing what
Phase 1 seeds would have silently narrowed every existing tenant on deploy.

**An edit is refused on a node the editor cannot reach.** `document:permission:manage` is capability;
reaching the node is the second question, and `DefaultPermissionService` asks the same resolver that
would answer it for any other act. Without that, holding the permission anywhere would let somebody
grant themselves reach everywhere — the privilege escalation 08 §8's table forbids and the sharpest
edge this phase adds. It is asserted in the integration suite.

**A truncated read degrades closed.** A caller whose entries exceed `ACL_MAX_SUBJECT_ENTRIES` loses
the tenant-wide allow and keeps every deny that was read; the repository orders denies first so that
even a wrong truncation keeps the closed half.

**The inverse risk is the one the screen exists for.** A `DENY` that inherits further than intended,
or a break that hides a subtree from the people accountable for it, is a compliance failure nobody
reports, because the screen simply shows less. ADR-0005 asked for the mitigation by name and
`Decision.decidedAt` had carried the field since Phase 0.5 unread:
`documents/[documentId]/permissions/` now renders the **effective** permission and the **node that
decided it**, and renders the chain — with any break marked — whether or not anybody has been named.

## 4. A defect six phases old, found by making the guard fire

Phase 9's limit row said `ACCESS_DENIED` was "wired but unreached": `AclGuard` was a global guard,
`AccessDenialRecorder` wrote the row, and **`@ScopedTo` was used by exactly zero routes**. Putting it
on the object routes was expected to be the moment every existing suite found out whether it had been
relying on not being checked. It was, and it found something else first.

**A JWT carries `roles` as role keys.** `authentication.service.ts` fills the claim from
`credential.roleKeys` and has since Phase 1. `role_permission.role_id` and `acl_entry.subject_id` are
UUIDs. `PrismaAclResolver` has compared the two directly since Phase 8 and matched nothing — every
`resolve` with a non-empty role list would have answered "closed by default" or raised a UUID parse
error, and neither was ever observed, because nothing that could *observe* a grant ran with a
non-empty role list: the guard was bound to no route, and every suite touching the resolver built its
subject with `roles: []`.

Fixed in one place — `AclRepository.roleIdsFor`, which accepts keys or ids — rather than at the six
call sites that build a subject from the request context. The alternative, putting role ids in the
token, was rejected: the claim is also what `RbacGuard` and the navigation filter read, and a token
carrying opaque ids would make every log line and every debugging session a lookup.

Four suites then found out they had been relying on not being checked. Each is fixed by **seeding the
grant its context always claimed**, never by keeping the resolver from asking — a suite that passes
because the check does not run is a suite that keeps passing after the check breaks. Two of them
(notification, audit) also needed a real document: the walk is object-dependent, which is
`AccessDenialRecorder`'s own prediction arriving — *"when the ACL walk arrives and decisions become
object-dependent, the condition starts to matter"*.

## 5. What it costs

**A decision is more expensive than it was.** Phase 8's resolver was one query against
`role_permission`. It is now up to five chain reads plus one entry read, and `AclGuard` runs on every
object route. 08 §8's cache arrives with the walk exactly as `PrismaAclResolver`'s own comment said
it would — *"it arrives with the walk, whose cost will warrant it"* — caching the chain per
`(tenant, scope)`, the decision on §8's key, and the visibility filter per
`(user, roles, permission)`.

**Invalidation is by prefix, inside the transaction that caused it.** A cache keyed by node cannot
express "and everything under it" without walking the tree it was added to avoid walking, so an ACL
edit clears `acl:<tenant>:`. That is a cost paid by the administrator making the edit, on an
operation that happens a handful of times a week, in exchange for never serving a decision from
before it.

**The dashboard's query bound moved, and it is still a constant.** Its suite asserts that the number
of queries does not change when the tenant gains ten times the rows; that still holds. The absolute
bounds went from ≤9 and ≤13 to ≤13 and ≤19, which is the ACL predicate, and the suite's comment says
so rather than the numbers drifting quietly.

**The document list is one extra resolution per request**, cached across the widgets and counts that
share it. A tenant with no ACL entries — which is every tenant that has never opened the permissions
screen — takes the unconditional branch: the tenant-level grant with no exclusions, which is the
absence of an allow clause rather than a predicate.

**Search lags an ACL change** by the reprojection of the affected subtree. §2.5 says what that costs
and what it does not.

## 6. What was built

| | |
| --- | --- |
| Tables | `acl_entry`, `mfa_enrolment`, `mfa_recovery_code` |
| Domain | `library/domain/acl-walk.ts`, `identity/domain/totp.ts` |
| Ports | `ACL_REPOSITORY`, `SCOPE_CHAIN_READER`, `PERMISSION_SERVICE` (all three declared since Phase 0.5), `MFA_REPOSITORY`, `MFA_SERVICE` |
| Routes | `GET/PUT /v1/scopes/{type}/{id}/permissions`, `GET …/effective`, `PUT …/inheritance`, `GET/POST/DELETE /v1/auth/mfa[/enrolment[/confirm]]` |
| Audit actions | `ACL_GRANTED`, `ACL_REVOKED`, `INHERITANCE_BROKEN`, `MFA_ENROLLED`, `MFA_FAILED` |
| Permissions | **None.** `document:permission:manage` has been in the catalogue and seeded since Phase 1; this is what gates on it |
| Web | `documents/[documentId]/permissions/`, `(auth)/mfa/`, the code field on the sign-in form |
| ADR | [0016](../architecture/adr/0016-inheritance-break-truncates-the-chain.md) |

Five audit actions, which is what 13 §2 gives this phase, and no others.

## 7. Deliberate limits

| Limit | Why | Owner |
| --- | --- | --- |
| **WebAuthn is not built** | CBOR, COSE and attestation formats should not be hand-written in a security product, and the sandbox cannot add a dependency | Phase 17 |
| **17 §2's MFA role policy is not enforced** | Switching it on locks out exactly the accounts that administer a tenant; it needs an operator-side way back in | Phase 17 |
| **Share is not built** | Three meanings, three threat models, and 17's threat table has no row for any of them (§2.7) | Phase 16 or 17 |
| **The TOTP secret is sealed with a key derived from the signing secret** | 05 has no column-encryption facility, and adding one for a single column is wider than this phase warrants. It defends a database disclosure, not a compromised application | Phase 18, with a key management service |
| **No QR code on the enrolment screen** | Rendering one needs a dependency the sandbox cannot add; the `otpauth://` link and the base32 key are both offered | Phase 16 |
| **Entries are not settable on `TENANT`, `COMPANY` or `ENTITY` from any screen** | The API accepts them and the walk resolves them; no screen exists above a document, because 16 §2 names one route and this phase built that one | Phase 16 |
| **Step 8's modifiers are not in the resolver** | Collapsing them into the reach question would turn "you may not print this" into "this does not exist" (§2.4) | Deliberate, permanent |
| **The `S` rows of 08 §6's matrix are expressible, not seeded** | Changing the Phase 1 seed would silently narrow every existing tenant on deploy | An administrator, per tenant |
| **A bulk "apply to subtree" edit does not exist** | Every edit is one node; inheritance is the mechanism for reaching a subtree, and a bulk write would be a second one with no audit shape | Not planned |

## 8. Limit rows discharged from earlier reports

Earlier reports are historical and are never edited; their rows are discharged here.

**Phase 9 — "`ACCESS_DENIED` from `AclGuard` is wired but unreached."** Discharged. `@ScopedTo` is on
every object route, the guard fires, and the integration suite asserts both the refusal and the row
it writes. §4 records what making it fire found.

**Phase 13 — "the document counts apply no ACL predicate beyond the tenant-level grant."** Discharged,
and the mechanism its report predicted is the mechanism that worked: the predicate went into
`whereFor`, and the counts inherited it with no change to `dashboard.service.ts` (§2.3).

**Phase 13 — "`PrismaAclResolver` is unchanged."** Discharged. It is extended, and no caller changed.

**13 §2 — `ACL_GRANTED`, `ACL_REVOKED`, `INHERITANCE_BROKEN`.** Written. `INHERITANCE_BROKEN` is
written only in the direction ADR-0005 names; restoring inheritance is a `FOLDER_CHANGED`.

**13 §2 — `MFA_ENROLLED`, `MFA_FAILED`.** Written.

**13 §2 — `SESSION_REVOKED`.** Was **already written**, by Phase 1's refresh-replay detection. The
ownership table was stale rather than the code incomplete, and 13 §2 now says so. This phase adds a
third call site.

**Phase 8 — `library/domain/acl-subjects.ts`'s prediction.** It said that when the ACL phase arrived,
"entries below a node that breaks inheritance stop carrying the grant token and start carrying
explicit subject tokens; the predicate, and everything above it, does not change." It held exactly.
The caller-side token function, the fingerprint and the engine's `&&` predicate in
`postgres-search.adapter.ts` are byte-for-byte what Phase 8 wrote. The only thing that changed is
that `acl_deny_subjects` is now sometimes non-empty — it was always in the shape and the adapter
always excluded on it; there was simply nothing to put in it.

## 9. Verification

All six gates clean: `format:check`, `lint`, `typecheck`, `test`, `test:integration`, `build`.

The integration suite runs against two real tenant databases. Phase 14's own assertions are database
questions, and they are the ones the brief named:

- **A deny beats a lower allow**, over rows on a real chain, and names the node an administrator
  would edit.
- **An inheritance break stops the walk** — including the tenant-level grant — **while an
  administrative permission passes anyway**, with an ordinary permission refused for the same caller
  on the same node so the assertion is about the exemption rather than about being an administrator.
- **A cross-scope read answers "not found"**, and the refusal is in the trail.
- **The same document is visible to one caller and absent — not forbidden — from another's list *and
  its total*.** A fetch-then-filter implementation passes the first half and fails the second, which
  is why the total is asserted.
- **The search index and a direct read agree** before and after an ACL change, compared through the
  engine's own predicate written out in the test.
- **A warm cache agrees with a cold one** across an edit that invalidates it.
- **An edit is refused on a node the editor cannot reach.**

`acl-walk.spec.ts` asserts the same rules without a database, so a defect in the queries and a defect
in the decision are distinguishable. `totp.spec.ts` asserts RFC 6238's published vectors, because "it
agrees with itself" is exactly the assertion a wrong implementation also passes.

**Every ACL entry in the ACL suite is written through `PermissionService` in a request context**, not
as `edms_owner`. CI's owner is the cluster superuser, so a suite seeding `acl_entry` with it writes
past the row-level security the rows are supposed to be subject to — and is then not testing what a
request would see. The owner client is used only for fixtures a request could not create for itself:
the tenant, the people, and the role grants an administrator would have made first.

Two defects were found by writing the tests rather than by reading the code:

- An unconditional allowed region was spelled `OR: [{}]`, which Prisma reads as a branch with no
  condition and drops — so a caller entitled to the whole tenant saw **nothing**. It is now the
  absence of an allow clause, which is also the shape almost every request takes.
- `MFA_FAILED` on a refused confirmation was rolled back by the exception that reported it. It now
  commits in its own transaction, as `signIn` does and for the same reason: a refused attempt is
  exactly the event somebody would prefer to leave no trace of.
