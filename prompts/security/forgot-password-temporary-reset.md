# Forgot Password & Temporary Password Reset

Status: implemented · Owner: Auth · Last updated: 2026-06-21

This document is the architecture summary and security review for the self-service Forgot Password
workflow. It extends the existing authentication stack (NestJS API + Next.js Admin Portal + Flutter
mobile) rather than replacing it — no auth code was rewritten.

## 1. Architecture summary

The flow is **temporary-password based** (not a magic-link token): a Forgot Password request issues a
cryptographically secure temporary password, emails it to the user, and forces a password change at
next login.

```
Login screen ──"Forgot password"──▶ /forgot-password (email)
        │                                   │
        │            POST /api/v1/auth/password/reset/request  (always 202, generic message)
        │                                   ▼
        │     AuthService.requestPasswordReset:
        │       • per-email rate limit (audit-backed)            • generate temp password (scrypt-hashed)
        │       • mustChangePassword = true                      • passwordResetIssuedAt / ExpiresAt (24h)
        │       • revoke all sessions                            • MailService → admin@munaxa.com
        ▼
Login with temp password ──▶ access token carries mcp=true (mustChangePassword)
        │
        ├─ MustChangePasswordGuard blocks every protected API except /auth/me + /auth/password/change
        └─ Admin <Shell> redirects to /change-password (mandatory)
                    │
        POST /api/v1/auth/password/change (currentPassword = temp, newPassword, confirmPassword)
                    ▼
          • policy + breach + reuse checks   • mustChangePassword = false
          • clears reset window (temp invalidated)   • lastPasswordChangeAt set
          • revokes all sessions → user re-authenticates normally
```

### Key components

| Concern | Location |
| --- | --- |
| Temp-password generation (CSPRNG) | `apps/api/src/auth/services/password.service.ts` → `generateTemporary()` |
| Hashing (scrypt, same as login) | `password.service.ts` → `hash()` / `verify()` |
| Issue / expire / first-login / complete | `apps/api/src/auth/services/auth.service.ts` |
| Forced-change gate (server) | `apps/api/src/auth/guards/must-change-password.guard.ts` (global APP_GUARD) |
| Whitelist decorator | `apps/api/src/auth/decorators/allow-during-password-change.decorator.ts` |
| Email (Resend, reused) | `apps/api/src/mail/mail.service.ts` → `sendTemporaryPassword()` |
| Forced-change gate (web) | `apps/admin/src/components/shell.tsx` |
| Pages | `/login`, `/forgot-password`, `/change-password` (admin) |
| Dedicated audit trail | `PasswordResetAudit` table |

## 2. Database changes

Additive, backward compatible (all new columns nullable). Migration:
`prisma/migrations/20260621120000_password_reset_temp/`.

**User** (new columns): `passwordResetIssuedAt`, `passwordResetExpiresAt`, `lastPasswordChangeAt`.
`email` and `mustChangePassword` already existed (`email` is required and `@@unique([tenantId, email])`).

**PasswordResetAudit** (new, append-only, RLS-enforced):
`id, tenantId?, userId?, email, action, ipAddress, userAgent, createdAt`.
`tenantId`/`userId` are nullable so anti-enumeration `reset.request` events (received before the email
is resolved) are still recorded. Append-only: only SELECT/INSERT policies exist under `FORCE ROW LEVEL
SECURITY`; UPDATE/DELETE are denied to everyone.

## 3. Email

Reuses the existing **Resend** integration (no second provider). Sent from `EMAIL_FROM_ADMIN`
(default `Munaxa <admin@munaxa.com>`) with both HTML and plain-text bodies, subject
**“Munaxa Temporary Password”**. The temporary password is rendered for the user but never logged.
No-op safe: with `RESEND_API_KEY` unset the send is skipped and reported as `{ sent: false }`.

## 4. Password policy (single source of truth)

Minimum 8 chars with upper, lower, number and special character. Enforced in three mirrored layers:
- Backend runtime: `PasswordService.assertStrong` (authoritative).
- API DTO: `PASSWORD_PATTERN` / `PASSWORD_MIN_LENGTH` (class-validator).
- Frontend: `apps/admin/src/lib/password-policy.ts` (live checklist on the change screen).

Generated temporary passwords are guaranteed to satisfy the policy.

## 5. Security review

| Requirement | How it is met |
| --- | --- |
| CSPRNG temp password | `crypto.getRandomValues` in `generateTemporary()` (14 chars, all classes). |
| Never store plaintext | Only the scrypt hash is persisted (overwrites `passwordHash`). |
| Same hash as auth | scrypt via `PasswordService.hash` (the login KDF). |
| User enumeration | Always 202 + generic message; unknown email/rate-limit trips are silent. |
| Generic message | “If the account exists, a password reset email has been sent.” |
| Rate limiting (IP) | `@Throttle({ limit: 5, ttl: 60s })` on the request endpoint. |
| Rate limiting (email) | Audit-backed per-email cap (3 / 15 min) inside `requestPasswordReset`, silent. |
| 24h expiry | `passwordResetExpiresAt`; expired temp login → 403 + `reset.expired_attempt` audit. |
| Invalidate previous temp | New request overwrites `passwordHash`; old temp + old password both die. |
| Prevent reuse | Change clears the reset window; new password must differ from current; sessions revoked. |
| Audit | `reset.request`, `reset.email_sent`, `reset.first_login`, `reset.completed`, `reset.expired_attempt` (+ generic `AuditLog`). |
| Route protection | `MustChangePasswordGuard` (API) + `<Shell>` redirect (web); allow-list = change-password, me, logout, login. |
| Multi-tenant isolation | Resolution + RLS are tenant-scoped; resets for a shared email affect only the targeted tenant. |

### Residual notes / decisions
- **Email uniqueness is per-tenant** (`@@unique([tenantId, email])`), preserving the existing
  multi-tenant model where one person may hold accounts at multiple schools. Cross-tenant ambiguity is
  resolved with `tenantSlug`; without it, a globally non-unique email returns the generic 202 without
  issuing (no enumeration).
- **Forced change revokes sessions**, so after setting a new password the user re-authenticates. The
  web change screen redirects to `/login` accordingly.
- **Per-email rate limit fails safe**: it is evaluated from the dedicated audit trail within the reset
  transaction, so it cannot leak account existence.

## 6. Tests

- Unit: `password.service.spec.ts` (policy + CSPRNG temp generation),
  `must-change-password.guard.spec.ts` (gate logic).
- E2E (`test/password-reset.e2e-spec.ts`), 10 scenarios: request, non-existent email, per-email rate
  limit, temp login, forced change, expiry, reuse prevention, audit trail, route protection,
  multi-tenant isolation.
