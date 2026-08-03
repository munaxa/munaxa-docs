/**
 * `@edms/contracts` — the wire shapes the API and its clients agree on.
 *
 * Foundation only in Phase 0.5: envelopes, errors, paging, capabilities, health. Resource
 * contracts arrive with the endpoints that serve them, in the phase that builds them.
 */
export * from './version';
export * from './http/headers';
export * from './common/capabilities';
export * from './common/envelope';
export * from './common/health';
export * from './common/identifiers';
export * from './common/pagination';
export * from './common/problem-details';
