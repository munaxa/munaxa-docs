# Demo starter configuration

A freshly provisioned tenant has no libraries, document types, numbering rules or other
administration settings, so there is nothing to file a document into. For **Testing and
development only**, the API image ships a one-off command that loads a small, generic starter
setup so people can try and learn the product straight away.

It never runs by itself: not at boot, not at provisioning and not at migration. It refuses to run
unless the operator states, for that run, a non-production environment and the tenant twice.

## What it creates

| Area                   | Items                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Departments            | QA Quality Assurance, HR Human Resources, FIN Finance, OPS Operations, IT Information Technology (under the tenant's root entity)                                  |
| Confidentiality levels | Public (10), Internal (20), Confidential (30, watermarked), Restricted (40, view only, reason required)                                                            |
| Retention policies     | STD-7Y (archive 7 years after superseded), FIN-10Y (review 10 years after publish), SHORT-2Y (purge 2 years after archive, review required)                        |
| Categories             | Management System (with Audits and Inspections), Health Safety and Environment, People, Finance, Technology, General                                               |
| Metadata fields        | Effective date, Next review due, Counterparty, External reference, Amount, Contract end date, Language (English, Arabic, German)                                   |
| Numbering rules        | `controlled-document` like `POL-QA-0001`; `yearly-record` like `INV-2026-00001` (restarts each year); `general-sequence` like `DOC-000001`                         |
| Approval               | Approval group `document-approvers` (starts with the tenant's current administrators) and the published workflow `standard-approval` (one stage, any member, 5 days) |
| Approver role          | The system **Approver** role, added to each administrator in `document-approvers` (their other roles are kept), so the people the workflow routes to can decide |
| Document types         | Policy, SOP, Work Instruction, Form, Contract (all with approval); Invoice, Report, Memo (reference types, no approval)                                             |
| Libraries              | Quality Management (Policies, Procedures, Work Instructions, Forms), Human Resources (Policies, Templates), Finance (Contracts, Invoices, Reports), General (Memos, Shared) |

The catalogue is `apps/api/src/demo/starter-catalogue.ts`. Everything it creates is ordinary
configuration: an administrator edits, retires or deletes it from the administration screens.

## How it behaves

- **Same rules as the screens.** Each item is parsed by the HTTP API's own `@edms/contracts`
  schema and created by the same application service, so validation, the audit trail, outbox
  events and the suspended-tenant refusal all apply. Audit rows record the system as the actor,
  channel `SYSTEM`, correlation id `seed-demo:<slug>`.
- **Additive and re-runnable.** Items are matched by code or key. Anything that already exists is
  left exactly as it is and reused; a second run creates nothing. Folders are only added to a
  library the same run created.
- **Respects retirement.** An item an administrator soft-deleted is not restored; anything that
  needs it is skipped and reported.
- **Approvers can approve.** The Tenant administrator role deliberately has neither
  `document:approve` nor `document:reject`, so an administrator assigned an approval task could
  see it but got "no permission" deciding it. The seeder therefore grants the Approver role to the
  administrators in the starter group. The Tenant administrator role itself is unchanged.
  Members an administrator added to the group are left to them, a member removed from the group
  is not touched, and nothing is ever revoked. Re-running the seed on a tenant seeded before this
  fix grants the role.
- **Dry run.** `DEMO_SEED_DRY_RUN=true` lists what would be created and writes nothing.
- **No sample documents.** Uploading files needs storage and the virus scanner; that is left to a
  person trying the product.

## Running it

| Variable                   | Required | Meaning                                                                       |
| -------------------------- | -------- | ----------------------------------------------------------------------------- |
| `DEMO_SEED_ENVIRONMENT`    | yes      | `development`, `test` or `nonprod`. Anything else, including unset, refuses. |
| `DEMO_SEED_TENANT`         | yes\*    | The tenant slug. \*A single-tenant install may rely on its `TENANT_SLUG`.     |
| `DEMO_SEED_CONFIRM_TENANT` | yes      | Must repeat the tenant slug exactly.                                          |
| `DEMO_SEED_DRY_RUN`        | no       | `true` to report only.                                                        |

Plus the API's normal configuration (database, tenant catalogue, Redis), which is why the hosted
way to run it is a one-off task from the **existing `docs-api` task definition** with only the
command and these variables overridden: no new secret and no infrastructure change.

```sh
# local / development, from the repository root after `pnpm build`
DEMO_SEED_TENANT=acme DEMO_SEED_CONFIRM_TENANT=acme DEMO_SEED_ENVIRONMENT=development \
  pnpm --filter @edms/api seed:demo

# hosted Testing: one-off ECS task from the docs-api task definition, container "docs-api",
# command ["node","apps/api/dist/seed-demo.js"], environment overrides:
#   DEMO_SEED_TENANT=<slug> DEMO_SEED_CONFIRM_TENANT=<slug> DEMO_SEED_ENVIRONMENT=nonprod
#   QUEUE_CONSUMERS_ENABLED=false   (as provisioning does: a one-off command consumes no queues)
```

Exit codes: `0` done, `1` failed (items created before the failure are kept; re-run), `2` refused
by the environment check (nothing opened), `3` database not migrated for this build, `5` tenant not
in the catalogue or not provisioned.
