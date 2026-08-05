# ADR-0018 — A machine caller is a delegated subject, never a principal of its own

- **Status:** Accepted
- **Date:** 2026-08-06
- **Phase:** 17

## Context

Phase 17's brief asks for a REST API that systems can call. The API already exists — every route
in this product is REST/JSON and has been since Phase 0.5 — so what the brief actually asks for is
something the product has never had: **a caller that is not a person**.

That sounds like a small addition and it is the most dangerous decision in the phase, because of
where `userId` sits in this codebase. It is not one field among many. It is the subject of *every*
reach decision:

- `ACL_RESOLVER.resolve(subject, scope, permission)` takes a subject.
- `ACL_RESOLVER.visibilityFilter(subject, permission)` builds the predicate a list is filtered by.
- `PrismaDocumentRepository.whereFor` reads it from the request context.
- `AclGuard` resolves a scope chain for it before a use case runs.
- The search index materialises `acl_subjects` from it.

And one line in `PrismaDocumentRepository.visibilityCondition` decides what happens when it is
absent:

```ts
const context = requireContext();
if (context.userId === null) {
  return {};                       // an empty predicate — every document in the tenant
}
```

That is correct for what it was written for. `userId` is null only on the outbox consumers and the
schedules, and the search projection has to materialise an entry's answer *for everybody* — a
projection filtered by the reach of a caller that does not exist would produce an index that shows
nobody anything. Row-level security is still the boundary on that path.

Phase 15 met the same line from the other side and worked around it, and its report says why in
one sentence: *"a consumer's context has no user in it and `visibilityCondition` answers a
subject-less caller with an empty predicate, which would have made every export a copy of the whole
tenant"*. It solved that by reconstituting the **requester** inside the export lane.

So the question this ADR answers is: when an API key authenticates, what goes in `userId`?

## Decision

**An API client is bound to a person, chosen when the key is minted, and acts as that person.**
`api_client.subject_user_id` is `NOT NULL` with no default. The authenticator puts it in
`RequestContext.userId`, and everything downstream is unchanged.

Its effective permissions are the **intersection** of that person's tenant-wide grants with the
scopes on the key:

```
effective = subjectPermissions ∩ ⋃(permissionsForScopes(scopes))
```

Both halves are read at **authentication time**, on every request, rather than copied onto the key
when it was created — which is Phase 11's rule for delegation authority applied to a credential,
for the same reason.

## Alternatives considered

**1. No subject — the key authenticates and `userId` stays null.**

This is the shape that looks natural, because a machine is not a person and putting a person's
identifier in the context feels like a lie. It is a **data breach**, not a design flaw: every list
route in the product would return the whole tenant to anybody holding any key, and the routes would
be behaving exactly as written. Nothing would log an error. The `403`s would all pass.

It is refused, and refused *structurally*: the column is not nullable, so an implementation that
tried this would fail to insert rather than fail at read time.

**2. A principal of its own — the key is a subject the ACL model knows about.**

Defensible, and it is what a mature integration platform eventually wants: a service account with
its own entries, nameable on a folder, visible on the permissions tab, its own row in an access
review.

It is refused for this phase on cost and on precedent.

The cost is that `AuthorizationSubject` gains a kind, and then so does everything that consumes
one: the resolver's four methods, the search index's `acl_subjects` materialisation and the
`aclSubjectsFor` projection that fills it, `AclEntry.subject_type`, the permissions screen's
"effective permission and the node that decided it", every `@ScopedTo` route's chain walk, and the
`visibilityFilter` regions Phase 14 built. Every one of those is a place a second kind of subject
can be handled *almost* correctly.

The precedent is Phase 11's, and it is the closer argument. 07 §4's first sentence decides that a
delegation is *"a routing overlay, never a permission grant"*, and Phase 11's report records the
consequence: 08 §3 lost its "active delegations" clause rather than the ACL resolver gaining a
subject, **because a delegation that could be named in an ACL entry would be the permission grant
§4 says it must never be**. A key that could be named in an ACL entry is the same object with a
different label. It would be a grant that exists outside the role model and outside the entry
model, held by whoever has the string.

**3. A delegated subject — the key acts as a person, narrowed by scopes.** Taken.

## Consequences

**Nothing in the authorisation model changed.** Not one caller of `ACL_RESOLVER` was touched, the
search index materialises the same subjects, `AclGuard` resolves the same chains, and
`visibilityCondition` never meets the case that would return everything. The integration suite
asserts the property directly: two keys bound to two people send the *same list request* and get
different rows and different totals — and neither total is the tenant's row count.

**A key cannot outlive the authority that justified it.** Removing a role from the subject removes
it from every key bound to them on the next call; disabling the account stops every key. That is
what makes offboarding work, and it is asserted rather than assumed.

**A key can never exceed its subject.** A client scoped `documents:write` whose subject may only
read writes nothing. The direction is the whole point — a union would have made the scope a grant.

**Some permissions are unreachable by any key, under any configuration.** `document:sign` is the
one that matters: 21 CFR Part 11 §11.200 requires a signature to be executed by the person, with
two identification components they alone control, and a key in a script is neither. It is absent
from every scope's list, so ADR-0017 stays true when a machine is calling. `user:manage`,
`role:manage` and `settings:manage` are excluded on the same mechanism.

**The honest cost, stated rather than buried.** A key bound to a tenant administrator *is* that
administrator, without a second factor and without a session anybody can end. The product cannot
prevent that and should not pretend to — an administrator who needs an integration with
administrative reach has a real requirement. What it owes instead is that the decision is
**visible**: the subject is a column in the list, it is in the `API_CLIENT_CREATED` audit payload,
and `audit_event.api_client_id` names the credential on every row it wrote — attested by the chain,
not merely recorded.

**A service account is still available to a customer who wants one**, and needs no product change:
they create a user, grant it the roles the integration needs, bind a key to it, and never set a
password. Phase 17's `identity_source` column is what makes such an account distinguishable from
an invitation nobody accepted — a distinction the product could not make before this phase.

**This ADR is supersedable rather than permanent.** The phase that genuinely needs a key nameable
in an ACL entry — a partner integration reaching one folder and nothing else, which no scope can
express — supersedes it with a new ADR and pays the cost above deliberately. What it must not do is
add a second subject kind quietly, one consumer at a time.
