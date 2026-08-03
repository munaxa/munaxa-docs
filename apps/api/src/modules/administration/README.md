# Administration module

**Answers:** How is this tenant configured?

| | |
| --- | --- |
| **Owns** | DocumentType, Category, MetadataField, NumberingRule and its sequences, RetentionPolicy, ConfidentialityLevel, TenantSettings |
| **Depends on** | Organization |
| **Binds in core** | `POLICY_EVALUATOR` and `FEATURE_FLAGS` — entitlements and settings are tenant configuration, which this module owns. |

## Layers

```text
administration/
├── administration.module.ts   composition for this module
├── domain/                    entities, value objects, pure rules, events — no Nest, no Prisma
├── application/               use cases and the ports this module declares
├── infrastructure/            Prisma repositories and adapters implementing those ports
└── presentation/              controllers, DTOs, OpenAPI decorators, view mappers
```

The dependency rule points inward, and it is enforced by `eslint.config.mjs` at the app root,
not merely described here. Other modules call this one through its **application service** or
react to its **events** — never through its repositories or its Prisma models.

## Events published

| Type | Meaning |
| --- | --- |
| `administration.document-type-changed` | Affects future documents only; documents already created keep their frozen policy. |
| `administration.numbering-rule-changed` | Never renumbers anything that exists. |
| `administration.settings-changed` | Invalidates configuration caches for the tenant. |

## Settings

Phase 1 implements the read path. `SETTINGS_READER` is bound to `CachedSettingsReader` and
exported globally, because configuration is a cross-cutting read rather than a dependency each
module should have to remember to import.

The catalogue lives in [`@edms/domain`](../../../../../packages/domain/src/settings.ts), not
here. That is deliberate: a module must be able to name the setting it needs without importing
this module's internals, which the boundary lint forbids and which would be the wrong shape
anyway. The same reasoning put the permission catalogue there.

**A setting that is not in the catalogue does not exist.** `get()` takes a definition rather
than a string key, so the return type is the setting's own type instead of `unknown`, and a
caller cannot ask for something undeclared — there would be nothing to pass. Writing an
undeclared key is refused outright.

**Reading settings cannot fail.** A stored value that no longer parses falls back to its
default and is logged; so does an unreachable database. A request served with default settings
is degraded, and a request not served at all is an outage — settings sit on paths that must
keep working.

**Out-of-bounds values are rejected, not clamped.** A stored `2` where the minimum password
length is `8` is somebody's mistake, and silently honouring `8` would hide it. The catalogue's
own bounds also mean a tenant cannot configure a password shorter than the standard floor,
however the value got there.

### Storage

One `jsonb` column on `tenant`, because settings are always read together and never joined
against: one read serves a request whatever it asks for, and the reader caches the *resolved*
bag so a hit skips parsing too.

Writes use `jsonb_set` rather than read-modify-write. Two administrators saving different
settings at the same time would otherwise each write a bag built from their own read, and the
later write would silently drop the earlier one's change.

`tenant` is the one table with no row-level security policy — it has no `tenant_id` to key one
on — so the explicit tenant filter here is the *only* thing separating one tenant's
configuration from another's. Everywhere else the database is a second line of defence; here it
is not, which is why the isolation case is covered by an integration test rather than argued.

### Cache invalidation

`invalidate()` drops a tenant's entry, and the writer calls it. Cross-process invalidation
rides on `administration.settings-changed` once the outbox dispatcher exists (R5); until then
the five-minute TTL bounds how long another process can hold a stale value.

## Phase 2 — the configuration a document type is assembled from

`CONFIGURATION_SERVICE` (behind `settings:manage`), `NUMBERING_ADMIN_SERVICE` (`numbering:manage`) and
the retention endpoints (`retention:manage`) own six resources with the full administered lifecycle:
confidentiality levels, retention policies, categories, metadata fields, document types and numbering
rules.

Their **order** is part of the design. A document type *requires* a numbering rule and a default
confidentiality level, so those two are set up first; a retention policy, an approval workflow and any
number of metadata fields are optional. Anything a live document type depends on cannot be deleted, and
the refusal carries the count rather than being an action that fails when used.

### Numbering

`domain/numbering.ts` is the pure formatter and validator. `checkRule` refuses a rule with no sequence
segment or more than one, more than one optional segment, an optional segment with no separator to drop
with it, and a yearly reset with no year in the number. Each of those describes a rule that can produce
the same number twice, which is the one thing a document number may never do.

`formatNumber` drops an optional empty segment *together with its separator*, and leaves a visible gap
(`JO--007`) for a required empty one — because a silently-closed gap makes two different documents
render identically.

Padding cannot change while a rule has a live series: widening it would give one number two written
forms (`0042` and `00042`), which is the same defect as reusing one. The API refuses the change and a
new rule is created instead.

The preview endpoint is a `POST` that claims nothing. The builder renders a sample from an *unsaved*
rule, so there is nothing to `GET`, and drawing a real number to show a preview would burn one.

### Metadata fields

A field's `dataType` cannot change once the field exists. The value columns are typed, so a `TEXT`
value has nowhere to go in a `NUMBER` field, and every stored value would become either wrong or
unreadable. A field of the wrong type is deleted and replaced while it is unused.

`metadataValidationSchema` is a closed, `.strict()` shape rather than free-form `jsonb`: validation a
tenant writes runs against every document they create, and "whatever they typed" is not something the
product can promise to evaluate the same way twice. `pattern` is the one escape hatch, bounded and
compiled at save time so an invalid expression is a 422 rather than a runtime failure years later.

### Confidentiality

Ranks are unique per tenant, because rank *is* the level's identity to the product: conditions compare
it, audit-on-read is triggered by it, and "more sensitive than" only has an answer if the order is
total. Every handling rule subtracts — a level may forbid download to somebody who holds
`document:download`, and none of them can grant it to somebody who does not.

## Still to build

`POLICY_EVALUATOR` and `FEATURE_FLAGS` are still unbound. They answer a different question from
settings: a flag hides unfinished work, an entitlement expresses what a customer bought, and a
setting is what the customer chose.

Approval groups — `ParticipantKind.GROUP` names one by key — have no administration surface yet. A
workflow can reference one; nothing creates one.
