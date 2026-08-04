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
export * from './admin/configuration';
export * from './admin/numbering';
export * from './admin/library';
export * from './admin/workflow';
export * from './admin/approval-routing';
export * from './admin/settings';
export * from './documents/upload';
export * from './documents/document';
export * from './workflow/approval';
