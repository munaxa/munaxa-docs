/**
 * `@edms/contracts` — the wire shapes the API and its clients agree on.
 *
 * Resource contracts arrive with the endpoints that serve them, in the phase that builds them:
 * Phase 0.5 shipped the foundation (envelopes, errors, paging, capabilities, health), and Phase 2
 * adds `admin/` — every administered resource, its create and update bodies, its list query and
 * its representation.
 *
 * Phase 3 adds `documents/` — the upload handshake and the document library. The one shape worth
 * noticing there is the split between a document's *file* and its *metadata*: what the bytes are
 * and what the document means are two objects on the wire because they are two facts with two
 * lifetimes.
 *
 * Phase 4 adds `workflow/` — a *running* approval, which is deliberately not the same contract as
 * the definition it runs. `admin/workflow.ts` is what somebody authors; `workflow/approval.ts` is
 * what somebody being asked to decide sees, and it is a timeline rather than a set of rows, because
 * a client assembling one from three flat collections could render it in an order the engine did
 * not mean.
 *
 * Phase 6 adds `documents/revision-control.ts` — check-out, check-in, publication, the revision
 * history and the compare. The one shape worth noticing there is the pair of dates: instants are
 * ISO date-times, the effective window is calendar days, because "effective from the 1st" is a
 * statement about a day in the tenant's own calendar rather than a moment in UTC.
 *
 * Phase 7 adds `documents/preview.ts` — the viewer's manifest, content URL and extracted text.
 * The shape worth noticing is the manifest's split between *state* (whether rendering is done)
 * and *confidentiality* (what the level subtracts): the UI combines the second with the caller's
 * own permissions, and a level only ever narrows. It also widens the compare contract's
 * `text.state`, which Phase 6 shipped as `UNAVAILABLE` with exactly this filling-in in mind.
 *
 * Phase 10 adds `retention/` — the recycle bin, the mandatory delete reason, legal holds and the
 * disposition queue. The shape worth noticing is what is *absent*: there is no purge request. The
 * only manual step retention offers a client is approving a disposition the policy already
 * scheduled (ADR-0010), so the wire cannot express the button the design rejected.
 *
 * Phase 12 adds `notifications/` — the in-app inbox, per-type preferences, quiet hours and the
 * tenant's template overrides. The shape worth noticing is what a preference *cannot* say: there
 * is no address field anywhere in it. Where a notification goes is the account's own verified
 * address, and a client that could set one could redirect somebody else's mail — 18 §8's fourth
 * prohibition, expressed as an absent field rather than as a check.
 *
 * Phase 9 adds `audit/` — the trail's read surface, its verification status and its evidence
 * exports. The shape worth noticing is `chainHashVersion` travelling beside `hash` on every entry:
 * it is what says how much that digest proves, because rows written before Phase 9 attest nine
 * fields and rows written since attest every column but the hashes themselves. A client that
 * rendered "verified" identically for both would be overstating the older half of the trail.
 *
 * Phase 11 adds `identity/delegation.ts` — the routing overlay of `07-workflow-architecture.md`
 * §4. The shape worth noticing is what a client cannot say: there is no status field on any
 * request body. Whether a delegation is in force is the server's answer, from the tenant's
 * approval setting and from who agreed to it — a client that could name the status could grant
 * itself the authority the approval exists to gate. The emergency path is a second body rather
 * than a flag on the first, so the bypass is never one character away from the ordinary request.
 *
 * These schemas are the *only* definition of each shape. The API validates with them and the web
 * forms validate with them, so a filter the UI can build is a filter the API accepts by
 * construction, and a field one side adds is a field the other side's build sees
 * (`docs/architecture/15-api-architecture.md` §6).
 */
export * from './version';
export * from './http/headers';
export * from './common/capabilities';
export * from './common/envelope';
export * from './common/health';
export * from './common/identifiers';
export * from './common/pagination';
export * from './common/problem-details';
export * from './common/query';
export * from './admin/record';
export * from './admin/organization';
export * from './admin/identity';
export * from './identity/delegation';
export * from './admin/configuration';
export * from './admin/numbering';
export * from './admin/library';
export * from './admin/workflow';
export * from './admin/approval-routing';
export * from './admin/settings';
export * from './documents/upload';
export * from './documents/document';
export * from './documents/revision-control';
export * from './documents/preview';
export * from './workflow/approval';
export * from './search/search';
export * from './audit/audit';
export * from './retention/retention';
export * from './notifications/notification';
