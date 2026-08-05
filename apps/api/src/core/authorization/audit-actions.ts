/**
 * The audit action authorisation writes.
 *
 * `08-permission-model.md` §7's last row — "every denied attempt on an existing object is audited
 * as `ACCESS_DENIED`" — and 13 §2 files it under Permission. `writeStandalone` was written in
 * Phase 1 for exactly this caller ("a denied read, a failed login") and nothing in
 * `core/authorization/` had ever called it. Phase 9 is where that stops being true, because a
 * compliance phase that built a screen for reading the trail and left the trail missing its
 * refusals would have built the wrong half.
 *
 * It lives in `core/` rather than in a module because no domain module performs a refusal: the
 * guard does, before any use case runs, and the module that performs an act is the module that
 * records it.
 */
export const AuthorizationAudit = {
  /**
   * A caller was refused reach on an object that exists.
   *
   * "On an existing object" is the whole of the rule and it is a security property, not a
   * nicety. A denial for an identifier that names nothing must not be recorded, because a trail
   * that distinguished "denied" from "absent" would answer, for anybody who could later read it,
   * the existence question the `404` was written to withhold.
   */
  ACCESS_DENIED: 'ACCESS_DENIED',
} as const;

export type AuthorizationAuditAction = (typeof AuthorizationAudit)[keyof typeof AuthorizationAudit];
