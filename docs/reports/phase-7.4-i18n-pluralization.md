# Phase 7.4 — Internationalization Pluralization Architecture

**PARTIALLY COMPLETE.** The mechanism is built and VERIFIED. The English copy is migrated and
VERIFIED. **Every Arabic plural form is ARABIC REVIEW REQUIRED**, and no Arabic word was invented to
pretend otherwise.

---

## 1. Initial architecture audit

Reproduced from the repository before anything was changed.

| Question | Answer |
| --- | --- |
| How are keys represented? | Dotted paths into a nested object literal |
| How is `MessageKey` generated? | `LeafPaths<Catalogue>` — recurses until `T[K] extends string` |
| How is `Catalogue` generated? | `Widen<typeof en>`, where `en` is `as const` |
| How does interpolation work? | `message.replace(/\{(\w+)\}/g, …)` against a values record |
| Client-side | `useTranslate()` → `translatorFor(useSession().locale)` |
| Server-side | `getTranslator()` → `translatorFor(await currentLocale())`, memoised per request |
| Does the API use the same catalogue? | **Yes** — `all-exceptions.filter.ts` calls `translate(locale, …)` for every problem detail |
| Statically typed bundles? | Yes; the Arabic catalogue is typed `: Catalogue`, so a missing key fails the build |
| May a value be an object today? | **No.** `lookup` returned `typeof current === 'string' ? current : undefined` |
| Any pluralization already? | **None** |
| `Intl.PluralRules` anywhere? | **Nowhere.** `Intl.DateTimeFormat` and `Intl.NumberFormat` are used; `PluralRules` is not |
| Is the locale known where translation happens? | **Yes** — it is the first argument of every call |

The last row is what made this tractable: nothing had to be threaded anywhere new.

## 2. The 28-string inventory

Extracted by walking both catalogues and collecting every leaf containing `{count}`. **28 in
English, 28 in Arabic** — Phase 7.3's number, confirmed independently.

The three competing hedges it named are all present, and there are two of the *same* idea written
two different ways in one catalogue:

```
admin.grid.rowCount   '{count} rows'      ← wrong at one
reports.rowCount      '{count} row(s)'    ← the parenthetical hedge, same idea
admin.roles.inUseByMembers  '{count} person/people hold this role…'   ← the slashed hedge
```

## 3. Classification

**A — true plural (23, migrated).** Every string where a noun, verb or adjective agrees with
`{count}` in at least one supported language. This includes four where English happens to be
invariant — `{count} unread`, `{count} selected`, `{count} unreferenced`, `{count} failed
unexpectedly` — because **Arabic still inflects them**, and a message that cannot express that would
have to be migrated again later.

**B — a number that pluralises nothing (2, not migrated).**
`admin.list.count` `'{count} of {total}'` and `recycleBin.count` `'Showing {count} of {total}'`.
Two bare numerals and a preposition; nothing agrees with either.

**G — the noun agrees with the *other* variable (3, not migrated).**

```
search.resultsCount  '{count} of {total} results'
audit.resultsCount   '{count} of {total} events'
audit.showingRecent  'Showing the {count} most recent of {total} events'
```

"results" agrees with `{total}`, not `{count}`. Selecting on `count` would produce "1 of 12 result".
Supporting it means letting a message declare *which* variable selects its form — a third parameter
or a per-message selector field, and more API surface than the rest of this design needs. §14 says to
stop when a key's intended meaning is ambiguous, and it genuinely is: the right fix may be to
restructure the sentence rather than to pluralise it. **Deferred with the reason, not migrated
badly.**

**Also found, outside the catalogue and outside this phase's scope** — recorded because they are the
same defect somewhere else:

- `apps/api/…/reporting/domain/report-pdf.ts:94` — `` `${input.totalRows} row(s)` ``, a user-visible
  English string built in the API that **never enters the catalogue at all**. A separate defect: not
  a pluralisation gap but an i18n gap.
- `apps/api/…/notification/domain/default-templates.ts` — `{{useCount}} decision(s)`,
  `{{documentCount}} document(s)`. Notification templates use a **different** `{{…}}` engine and are
  **tenant-editable overrides** (Phase 6.4). Pluralising them raises a question this phase cannot
  answer: does a tenant administrator author six Arabic forms in a template editor? **STOP —
  documented, not attempted.**
- `apps/web/src/test/a11y.tsx` — `violation(s)`, `element(s)`. Developer-facing test output, never
  translated. Correctly out of scope.

`count === 1` also appears four times in Prisma repositories (`return count === 1`). Those are
rows-affected checks, not plurals — the concrete case for §3's warning that not every `count` is one.

## 4. The architecture

**`packages/i18n/src/plural.ts`** — 116 lines, no dependency added.

```ts
declare const PLURAL_BRAND: unique symbol;

export interface PluralForms {
  readonly other: string;                    // required — every locale has it
  readonly zero?: string; readonly one?: string; readonly two?: string;
  readonly few?: string;  readonly many?: string;
}
export type PluralMessage = PluralForms & { readonly [PLURAL_BRAND]: true };

export function plural(forms: PluralForms): PluralMessage;
export function selectPluralForm(locale: LocaleKey, message: PluralForms, count: number): string;
```

Selection is `Intl.PluralRules`, cached one instance per locale. **No plural table is written in this
repository.** Which categories a locale uses, and which number lands in which, is the runtime's
business — so adding a language means adding a catalogue, not teaching a file about a grammar. No
third-party dependency was introduced; §4's preference for the native capability was available and
taken.

**Why the brand.** `LeafPaths` walks until it finds a `string`. A plural message is an object, so
without a way to recognise one it would mint `admin.grid.rowCount.one` as a `MessageKey` — changing
the key type every call site in the API, the worker and the web app depends on. `plural()` returns a
branded type; the brand exists only in the type, so at runtime the catalogue is still a plain tree
and `en.state.error` still reads as a string.

## 5. Message type changes

```ts
type LeafPaths<T, P> = { [K in keyof T & string]:
  T[K] extends string        ? `${P}${K}`
  : T[K] extends PluralMessage ? never          // ← plural keys are not MessageKey
  : LeafPaths<T[K], `${P}${K}.`> }[keyof T & string];

type PluralPaths<T, P> = { … the mirror image … };

export type MessageKey = LeafPaths<Catalogue>;   // unchanged in meaning
export type PluralKey  = PluralPaths<Catalogue>; // new, disjoint by construction
```

`Widen` gained the same stop — widening *into* a plural message would strip the brand and let the
Arabic catalogue satisfy the type with a plain string where a set of forms is required.

## 6. API changes — one API, overloaded

§6 asks that a caller write `t('key', { count })` with no branching, and warns against two competing
APIs. Because `MessageKey` and `PluralKey` are **disjoint**, `translate` could be overloaded rather
than duplicated:

```ts
export function translate(locale, key: MessageKey, values?: Record<string, string|number>): string;
export function translate(locale, key: PluralKey,  values: PluralValues): string;
//                                                 PluralValues = Record<…> & { count: number }
```

`Translator` (returned by `translatorFor`, `useTranslate` and `getTranslator`) carries both
signatures. So:

- a plural message **cannot** be reached without a `count` — a compile error, not a convention;
- a plain message **cannot** be given a plural key;
- `count` is both the selector and an interpolation value, so it is passed once.

`tPlural()` was considered and rejected: two names for one idea is how a codebase ends up with half
its counted strings on the old one.

## 7. English migration

23 messages, `one` + `other`. The hedges are gone:

| Key | Before | After (`one` / `other`) |
| --- | --- | --- |
| `admin.grid.rowCount` | `{count} rows` | `{count} row` / `{count} rows` |
| `reports.rowCount` | `{count} row(s)` | `{count} row` / `{count} rows` |
| `admin.roles.inUseByMembers` | `{count} person/people hold this role…` | `{count} person holds this role…` / `{count} people hold this role…` |
| `admin.list.inUseByTypes` | `Used by {count} document type(s). Change those first.` | `Used by {count} document type. Change it first.` / `…types. Change those first.` |
| `bulk.result.refusedHint` | `{count} were refused: …to them.` | `{count} was refused: …to it.` / `{count} were refused: …to them.` |
| `documents.upload.fileCount` | `File {count} document(s)` | `File {count} document` / `File {count} documents` |
| … 17 more | | |

Four messages have identical `one` and `other` because English does not inflect them
(`{count} unread`, `{count} selected`, `{count} unreferenced`, `{count} failed unexpectedly…`). They
are still plural messages, so Arabic can differ where English cannot.

## 8. Arabic migration — mechanism only

**No Arabic word was written, changed or invented.**

Each Arabic message carries the **single form the catalogue already shipped**, placed in `other`, with
a comment on every one:

```ts
memberCount: plural({
  // ARABIC REVIEW REQUIRED — the single form this catalogue already shipped, carried into
  // `other` so nothing a reader sees changed. Arabic selects across six categories and
  // this message answers with one; the remaining forms need a native reviewer.
  other: '{count} أشخاص',
}),
```

Two consequences, both deliberate:

1. **Arabic output is byte-identical to before this phase**, for every count. There is no regression
   and no false improvement.
2. Every Arabic count still renders the same words at 1, 2, 3 and 11 — which is wrong, was wrong
   before, and is now *visible in the source* as 23 marked messages rather than invisible.

## 9. Arabic review requirements

**23 messages × up to 6 categories.** For each, the reviewer needs: the English `one`/`other` above
(the semantic meaning), and the current Arabic form (already in `other`). The categories Arabic
selects — verified against `Intl.PluralRules('ar')` and asserted in the test suite — are:

| Count | Category |
| --- | --- |
| 0 | `zero` |
| 1 | `one` |
| 2 | `two` |
| 3–10 | `few` |
| 11–99 | `many` |
| 100, 101, … | `other` |

Every one of the 23 is grep-able: `rg "ARABIC REVIEW REQUIRED" packages/i18n/src/catalogues/ar.ts`.

## 10. Consumer migration

The type change found every consumer. **31 compile errors** on the first typecheck — 31 call sites
across the web application, none in the API, worker, contracts or domain. (The API consumes the
catalogue only for `error.*` messages, none of which is a plural.)

- **28** were fixed by giving `useTranslate` and `getTranslator` the `Translator` type instead of a
  hand-written `MessageKey`-only signature. No call site changed.
- **3** were real defects the types exposed:
  `numbering-reservations-screen.tsx`, and `upload-dialog.tsx` twice, each passing
  `count: String(…)`. A stringified count would have gone through `Number()` and worked by accident;
  the type now refuses it. `String(…)` removed at all three.

**No consumer is left on an obsolete shape.** `pnpm typecheck` covers all 13 packages, including the
API, worker and contracts, and passes.

## 11. Compatibility analysis

`MessageKey` is unchanged in meaning — still every plain string leaf — so nothing that used it had to
move. The keys of the 23 migrated messages are **unchanged**; only their value shape changed, and the
only consumer of a catalogue value's shape is `translate`.

`en` and `ar` are exported and read directly in three places (`app/error.tsx`, `visual.spec.tsx`,
`signing.e2e.spec.ts`). None reads a migrated key; all read plain strings, which are untouched. No
compatibility alias is required, and no key was deleted.

**Not a public contract.** `@edms/i18n` is a workspace package with no external consumers; the API
sends *rendered* problem details over the wire, never keys. So no breaking change leaves this
repository.

## 12. Tests

**26 in `@edms/i18n`** (up from 4), plus **3 rendering tests** in the web app.

- English: 0, 1, 2.
- Arabic: 0, 1, 2, 3, 5, 11, 100 — one per category, so a future change cannot quietly collapse
  Arabic to two forms.
- Missing category → `other` (an English-shaped message rendered in Arabic at 3).
- `NaN`, `Infinity` → `other`.
- Negative and fractional counts.
- Interpolation of `count` and of a second value beside it.
- A message that does not exist → renders the key, not an empty string.
- The bound translator (`translatorFor`) carries the overload.
- **Catalogue guards:** no `(s)`, `(es)` or `person/people` survives in *either* catalogue; and every
  `{count}` in a plain string is one of the five documented non-plural exceptions. A new counted
  string that skips `plural()` fails the build.

**Two of my own tests were wrong and were corrected rather than the code bent to fit them:**

1. I asserted `selectPluralForm('en', …, -1) === 'other'`. `Intl.PluralRules('en')` returns `one` —
   English cardinal rules select on absolute value. The test now asserts the runtime's real
   behaviour, with the mistake recorded in the test itself.
2. My catalogue-walking guard descended *into* plural messages and reported
   `auth.mfaEnrolledHint.one` as an unmigrated counted string — the opposite of the truth. The
   walker now treats a plural message as a leaf, exactly as `translate` does.

## 13. Browser verification, and a harness finding

**The visual suite could not see this change, and that is a finding rather than a pass.**

After the migration, `pnpm test:visual` reported **83 passed with no baseline change** — yet the
`document-list` baseline visibly read "1 rows". That contradiction was investigated rather than
accepted (§21): `matchesBaseline` tolerates `PIXEL_TOLERANCE = 120` changed pixels so antialiasing
does not fail a build, and a dropped "s" at this size is roughly **66**. The screenshot could not see
the fix — and could not have seen the defect either.

The tolerance was **not** lowered: it exists for a reason, and tuning it to catch one character would
make every build hostage to font rendering. Verification was moved to where it can be seen:

- **A runtime probe** against the built package: `"0 rows"`, `"1 row"`, `"2 rows"`,
  `"1 person holds this role…"`, `"3 people hold this role…"`, `"File 1 document"`.
- **`plural-rendering.spec.tsx`** — the real `LibraryScreen`, through the real provider tree and the
  real catalogue, asserting the rendered text says **"1 row"** and not "1 rows", plus "2 rows" and
  "0 rows". This is the client-side path end to end: `useTranslate` → `translatorFor` →
  `Intl.PluralRules`.

**NOT VERIFIED — RTL and Arabic rendering in a browser.** Arabic output is provably byte-identical to
before (every message resolves through `other`, which holds the string it always held), so there is
no new wrapping, direction or overflow risk introduced by this phase. But no Arabic screen was
rendered at 390px or in dark theme as part of this work, and §12's inspection list was not carried
out. Stated as not verified rather than inferred from the identity argument.

## 14. Remaining limitations

1. **ARABIC REVIEW REQUIRED — 23 messages.** The mechanism selects the right category; the words in
   it are one form doing the work of six.
2. **BLOCKED — the three `{total}`-driven messages** (§3, category G). Needs a product decision:
   restructure the sentence, or give a message a declared selector variable.
3. **KNOWN LIMITATION — the visual suite's 120-pixel tolerance** cannot see a single-character text
   change. Now documented and worked around by rendering assertions where it matters.
4. **Out of scope, recorded:** the API's `report-pdf.ts` string that never reaches the catalogue, and
   the tenant-editable notification templates on a separate `{{…}}` engine.
5. **NOT VERIFIED — Arabic in a browser** (§13).

## 15. Files changed

```
packages/i18n/src/plural.ts                        NEW — the engine
packages/i18n/src/plural.spec.ts                   NEW — 22 tests
packages/i18n/src/translate.ts                     PluralKey, overloads, Translator, lookup
packages/i18n/src/index.ts                         export * from './plural'
packages/i18n/src/catalogues/en.ts                 23 messages → plural(); Widen stop
packages/i18n/src/catalogues/ar.ts                 23 messages → plural({ other }) + review markers
apps/web/src/app/providers.tsx                     useTranslate(): Translator
apps/web/src/lib/server-i18n.ts                    getTranslator(): Promise<Translator>
apps/web/src/features/documents/upload-dialog.tsx  two String(count) removed
apps/web/src/features/admin-configuration/numbering-reservations-screen.tsx   one String(count) removed
apps/web/src/features/documents/plural-rendering.spec.tsx    NEW — 3 rendering tests
```

## 16. Gates

| Gate | Result |
| --- | --- |
| `pnpm format` | clean |
| `pnpm lint` | **0 errors**, 7 warnings — all pre-existing |
| `pnpm typecheck` | **13/13**, including api, worker, contracts, domain |
| unit | i18n **26** (was 4) · web **142** (was 137) · api 645 (1 skipped) · domain 164 · contracts 26 · utils 11 · worker 2 |
| `pnpm build` | 9/9 |
| `pnpm verify:styles` | 10/10 |
| visual + responsive (real Chromium) | **83 passed** — and §13 explains why that is weaker evidence than it looks |
| accessibility (axe) | included in the web suite above |
| **e2e — `signing.e2e.spec.ts`** | **27 passed, 0 failed** (real API, real Redis, real PostgreSQL, production build, real Chromium) |
| e2e — `recovery.e2e.spec.ts` | env-gated failure (`DR_DEST_ADMIN_URL` unset) — pre-existing since Phase 7.1B, unrelated, not skipped |
| integration | **not run.** No API, schema or contract behaviour changed; the API's only catalogue use is `error.*`, none of which is a plural, and the API typechecks. Reported as not run rather than inherited |

## 17. Evidence classification

**IMPLEMENTED** — the plural engine; `PluralKey`/`LeafPaths`/`Widen`; the `translate` overloads and
`Translator`; 23 English messages; 23 Arabic messages carrying their existing wording; three
stringified counts fixed; two new test files.

**VERIFIED** — category selection for English (0/1/2) and Arabic (0/1/2/3/5/11/100) against
`Intl.PluralRules`; fallback to `other` for a missing category and for a non-finite count;
interpolation; the bound translator; that no hedge survives in either catalogue; that no plain string
interpolates `{count}` outside the five documented exceptions; that the rendered library says
**"1 row"**; that all 13 packages typecheck; that the running application passes 27 E2E tests.

**ARABIC REVIEW REQUIRED** — all 23 Arabic plural messages. The *selection mechanism* is VERIFIED;
the *linguistic correctness* is not, and the two are deliberately reported apart.

**BLOCKED** — the three `{total}`-driven messages.

**KNOWN LIMITATION** — the 120-pixel visual tolerance; the API's uncatalogued `row(s)`; the
notification templates' separate engine.

**NOT VERIFIED** — Arabic rendered in a real browser at the widths and themes §12 lists.

## 18. Recommended next work

1. **Arabic review.** 23 messages, grep-able by marker, each with its English semantics beside it.
   This is the phase's outstanding half and it needs a person, not a commit.
2. **Decide the three `{total}` messages** — restructure, or extend the API with a declared selector.
3. **The notification templates.** Tenant-editable, on a different engine, and the design question
   ("does an administrator author six Arabic forms?") is worth answering before the feature grows.
4. **`report-pdf.ts`** — a user-visible string that never reaches the catalogue at all.
5. **An Arabic pass in the browser**, covering §12's list, once the copy exists to look at.
