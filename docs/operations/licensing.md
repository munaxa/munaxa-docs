# Licensing — installing, renewing and moving a licence

**For:** whoever operates a Munaxa Docs installation, hosted or on a customer's own server.
**Design:** [ADR-0026](../architecture/adr/0026-subscription-enforcement-through-the-shared-licensing-contract.md).

## 1. Choose the mode

| Deployment | `LICENSING_MODE` | Needs |
| --- | --- | --- |
| Development, or an installation sold without limits | `NONE` (default) | Nothing |
| On premises, no internet required | `LICENSE_FILE` | `LICENSE_FILE_PATH`, `LICENSE_PUBLIC_KEYS`, `LICENSE_INSTALLATION_ID` |
| Hosted | `CONTROL_PLANE` | `CONTROL_PLANE_URL`, `CONTROL_PLANE_TOKEN`, and the URL's host on `OUTBOUND_HTTP_ALLOWLIST` |

The API refuses to start when a mode's inputs are missing, and refuses a private key in
`LICENSE_PUBLIC_KEYS`. An installation holds public keys only: it can check a licence and cannot
make one.

## 2. Install a licence on premises

1. Choose the installation identifier and set `LICENSE_INSTALLATION_ID`. It is what the licence is
   bound to; keep it with the server's configuration.
2. Send Munaxa the activation request (the installation identifier, the licence id you were given
   and the reason `ACTIVATION`). Munaxa returns a licence file.
3. Copy the file to `LICENSE_FILE_PATH`. No restart is needed; the API re-reads it within
   `LICENSING_REFRESH_SECONDS`.
4. A tenant administrator can confirm it at `GET /api/v1/subscription`.

## 3. Renew

Copy the new file over the old one. A renewal is a new licence superseding the last; nothing else
changes.

## 4. Replace the server (controlled reactivation)

A licence is bound to one installation identifier, so a new server with a new identifier stops
verifying the old licence — on purpose. To move:

1. Set the new server's `LICENSE_INSTALLATION_ID`.
2. Send an activation request with reason `SERVER_REPLACEMENT`, naming the old licence id.
3. Install the licence Munaxa returns. It supersedes the old one, and the move is recorded as an
   installation reactivation.

Keep the database when you move: `entitlement_state.last_observed_at` travels with it and is what
keeps a wound-back clock from extending a licence.

## 5. What happens when something is wrong

| Situation | Effect |
| --- | --- |
| Licence file missing or unreadable | No growth at once; read-only after 7 days; export-only after 30 |
| Licence fails verification (forged, other installation, other tenant) | Refused; nothing is granted until a valid licence is installed |
| Server clock moved back past what the installation has seen | Refused as `CLOCK_ROLLBACK`; correct the clock |
| Licence term ended | Grace (no growth) until `graceUntil`, then read-only |
| Control plane unreachable (hosted) | Unchanged for 1 hour, no growth for 1 day, read-only for 7 days, then export-only |

Every case is logged as `Entitlements could not be confirmed` with a `reason`. Health checks and
password sign-in are never affected.

A `401` or `403` from the central service (a revoked or mistyped credential) is treated as the
service being unreachable, not as a cancellation: tenants degrade over hours as above rather than
losing access at once. Fix the credential; it is logged on every refresh.

## 5a. What the plan's features switch, beyond the API routes

| Feature | When the plan does not include it |
| --- | --- |
| `sso.federation` | Sign-in offers the password box; a federated callback already in flight is refused and recorded as `LOGIN_FAILED` with reason `FEDERATION_NOT_INCLUDED` |
| `integration.webhooks` | New events are not delivered (and not delivered later); recorded deliveries wait without spending attempts |
| `audit.stream` | Pushes stop; the cursor holds, so the stream resumes gap-free if the feature returns |

## 5b. Usage reporting (hosted)

Under `CONTROL_PLANE`, each tenant's `users` and `storage.bytes` are reported to the central service
every hour (17 minutes past) on the `licensing.usage` lane, by the process with
`QUEUE_CONSUMERS_ENABLED`. Reporting is informational: Docs enforces its own limits, and a failed
report is retried three times and then dead-lettered without changing anyone's access.

## 6. Limits of offline licensing

- A licence cannot be revoked offline. It remains valid until it ends; keep terms short.
- A clock that was wrong from the first boot and never moved backwards cannot be detected.
