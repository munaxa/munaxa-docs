# Munaxa sign-in only

Owner decision, 26 Nov 2026: there are no real users yet, so people sign in to Docs with their
Munaxa account (Munaxa Identity, its ADR-0008), not with a Docs password.

## Rules

- **Organisations with Munaxa sign-in on** (`feature.federation` true, the `sso.federation`
  licence, an enabled identity provider): a Docs password is refused after it is verified, with
  `FEDERATED_SIGN_IN_REQUIRED` (401), audited as `LOGIN_FAILED` with that reason. The web form
  says "Your organisation signs in with Munaxa".
- **Organisations without it** keep passwords, so turning it on is what retires them and nobody is
  locked out before.
- **`PASSWORD_SIGN_IN`** (API and web): `disabled` (production default), `emergency` (also lets a
  `TENANT_ADMIN` with a confirmed Docs authenticator use their password and code, audited `LOGIN_SUCCEEDED` with `method: PASSWORD_EMERGENCY`),
  or `enabled` (default elsewhere). The web `/login` sends people to **Sign in with Munaxa**
  unless it is `enabled`; the password form is one link away (`/login?password=1`).
- **Only a checked address finds an account.** A federated sign-in links an existing Docs user, or
  creates one (JIT), only when the id token says `email_verified: true`. Munaxa Identity sends
  that only for an address shown to belong to the person (munaxa-identity#34). Otherwise only an
  account already bound to that subject signs in (`EMAIL_NOT_VERIFIED`).
- **Administrators need a second factor.** The roles that need MFA with a password
  (`TENANT_ADMIN`, `DOCUMENT_CONTROLLER`, `AUDITOR`) need one through Munaxa too, at every
  sign-in and before anything is linked or created: Identity's `acr: "mfa"`, or an `amr` naming a
  second factor (`MFA_NOT_SATISFIED`).

`emergency` is for an Identity outage: switch it on, sign in, switch it off. It is still two
factors, so each tenant administrator who may need it enrols a Docs authenticator (profile, two-step
verification) beforehand; an administrator without one is refused like everyone else.
