# Phase 7.4B — Arabic Pluralization Policy & Completion

**Status: BLOCKED — ARABIC POLICY DECISION REQUIRED.**

Decision B is **resolved**: five of the six ambiguous messages now have their counted noun traced to
a producer and a renderer, and the sixth is unresolvable for a reason worth knowing. Decision A is
**not** resolved, and §3 of the brief decides what happens then: *"If no explicit policy exists, STOP
and report ARABIC POLICY DECISION REQUIRED. Do not choose one yourself."*

**No Arabic string was edited**, per §21's closing instruction that the 23 stay untouched until both
decisions are documented.

---

## 1. Scope

Resolve the two blockers Phase 7.4A named, then complete the 23. One resolved, one not, so the 23
are not touched. What this phase adds instead: an exhaustive and reproducible search for Decision A,
a producer-to-renderer trace for Decision B, a correction to Phase 7.4A's own arithmetic, and a
regression tripwire (§13).

## 2. Phase 7.4A blocker recap

- **Decision A** — the catalogue counts things four different ways, twice for the same noun
  (`{count} صفًا` in `admin.grid.rowCount`, `{count} صف` in `reports.rowCount`). No policy chooses
  between them, and the `two` form needs one because the repository writes duals but never beside a
  digit.
- **Decision B** — six keys count something the English never names.

## 3. Decision A — the search, and its result

**Searched, exhaustively and reproducibly:**

| Location | Extent | Result |
| --- | --- | --- |
| `docs/**` | **105 markdown files** — 22 architecture, 20 ADRs, `docs/ui/`, `docs/operations/`, `docs/reports/` | nothing |
| `ARCHITECTURE.md` | whole file | nothing |
| `packages/i18n` | no README, no docs; `translate.ts`, `plural.ts`, `locale.ts` comments | nothing |
| `packages/i18n/src/catalogues/ar.ts` | every comment | only the Phase 7.4 review markers |
| Terms searched | `plural`, `numeral`, `tamyiz`/`tamyīz`, `accusative`, `genitive`, `dual form`, `counting convention`, `numeral agreement`, `صفًا`, `مثنى`, `تمييز` | no hit outside my own 7.4/7.4A reports |

**The i18n rules that *do* exist** — and they are the whole of it:

- `ARCHITECTURE.md` / `16-frontend-architecture.md` §Rulebook 7: *"Every user-visible string from
  `@edms/i18n`"*.
- `16-frontend-architecture.md`: *"Logical properties only (`ps-`, `me-`, `text-start`) — the product
  ships EN + AR with full RTL"*.
- `16-frontend-architecture.md` §Phase 2: *"EN + AR catalogues, RTL verified per screen, dates and
  numbers formatted per locale, and Arabic document titles rendered with correct bidirectional
  handling beside Latin document numbers."*

Every one is about **where strings come from, direction, and number formatting**. Not one is about
grammatical agreement between a numeral and the noun it counts. The closest — "numbers formatted per
locale" — is about digits and separators, which §8 of the previous brief explicitly placed outside
this work.

**Result: ARABIC POLICY DECISION REQUIRED.** No convention exists to cite. §5 forbids substituting
general Arabic knowledge, naturalness, or grammatical validity for an approved product decision, and
all three are what I would have to fall back on. So the 23 are untouched.

## 4. Evidence supporting Decision A's outcome

The absence is the evidence, and it is a *proven* absence rather than an unsearched one — the table
in §3 is reproducible command by command. Two supporting observations:

- **The inconsistency is not accidental drift; it is unarbitrated.** Four strategies across 23
  messages, in a catalogue that is otherwise carefully written (it forms duals correctly and selects
  their case correctly). Whoever wrote it made a local choice each time because there was nothing to
  consult.
- **`bulk.bar.selected` is not evidence of a policy.** Its Arabic — `المحدَّد: {count}`, a label with
  a value — sidesteps agreement entirely and could be read as a house convention for counters. §10
  says the policy decides whether label/value construction is allowed and when; it does not let one
  string become the policy. Phase 7.4A offered it as an alternative and did not apply it; this phase
  does the same, and §11 of the report records why (§7 below).

## 5. Decision B — noun mapping

**First, the discrepancy §4 asks about.** Phase 7.4A's §6 says *"Five messages count something the
English never names (#18–#23…)"* — and `#18–#23` is **six**. **The prose was wrong; the count is
six.** Every one of the six has an implicit noun in English:

`notifications.unreadCount`, `dashboard.admin.unreferenced`, `bulk.bar.selected`,
`bulk.result.refusedHint`, `bulk.result.blockedHint`, `bulk.result.failedHint`.

The "five" in that sentence was a miscount, not a different set. Corrected here rather than in the
historical report, which §19 of the previous brief says not to modify.

**The trace.** Each value followed from the producer that computes it to the component that renders
it:

| Key | Producer | Renderer | Counted noun | Status |
| --- | --- | --- | --- | --- |
| `notifications.unreadCount` | `notification.controller.ts:95` `unreadCount(): Promise<{count:number}>` → `dashboard-metrics.adapter.ts:26` `unreadCount(userId)` | `notifications-screen.tsx:132` | **notifications** — the caller's own unread notifications | **NOUN VERIFIED** |
| `dashboard.admin.unreferenced` | `storage/dashboard-metrics.adapter.ts:34,54` → `unreferencedBlobs` | `dashboard-screen.tsx:371` | **stored blobs** — and its sibling `dashboard.admin.blobs` already renders that concept as "files" | **NOUN VERIFIED** |
| `bulk.result.refusedHint` | `bulkTallySchema.refused` (`contracts/documents/bulk.ts:116`) | `bulk-panel.tsx:65` | **documents** | **NOUN VERIFIED** |
| `bulk.result.blockedHint` | `bulkTallySchema.blocked` (`:117`) | `bulk-panel.tsx:70` | **documents** | **NOUN VERIFIED** |
| `bulk.result.failedHint` | `bulkTallySchema.failed` | `bulk-panel.tsx:75` | **documents** | **NOUN VERIFIED** |
| `bulk.bar.selected` | `selected.length` in `ResourceList` | `resource-list.tsx:336` | **polymorphic** — see below | **NOUN DECISION REQUIRED** |

**Why the bulk tally is documents and not "items".** The contract calls them targets
(`bulkItemResultSchema.targetId`) and the kind enum has five members, which reads generic. But
`BulkResultDialog` — the only component that renders these three messages — is imported by exactly
one screen: `library-screen.tsx:32`, the **document library**. There is no other consumer. The count
is documents, and it is documents at every call site that exists.

**Why `bulk.bar.selected` cannot be resolved.** It lives in `ResourceList`, the shared list component
behind the document library *and* 25+ administration screens — roles, users, departments, categories,
libraries, workflows. `selected.length` counts **whatever that list holds**. English absorbs this
because "3 selected" is noun-free; Arabic cannot, because any agreeing word must know the gender and
number of the thing selected. This is not a gap in my digging: **the product genuinely does not know
the noun at that call site.**

That makes it a design question with three shapes, and §4 says to stop rather than pick:

1. Pass the resource name into the message, so each list supplies its own noun.
2. Keep the label/value construction (`المحدَّد: {count}`) that needs no agreement — permitted only
   if the policy in Decision A allows it (§10).
3. Leave it invariant in both languages and accept the Arabic reads as a label.

## 6. Evidence supporting Decision B

Producer, contract and renderer for each of the five verified nouns are cited by file and line in
§5, and every one was read rather than inferred from the key's name. The sixth is unresolvable from a
*positive* finding — `ResourceList`'s genericity, which is the same property that makes it valuable —
rather than from missing evidence.

## 7. Complete 23-message inventory, and the six categories

**Not produced, and deliberately.** §17 asks for `zero`/`one`/`two`/`few`/`many`/`other` per message.
Every one of those cells is determined by the policy in Decision A: which construction the numeral
takes, whether `zero` is a numeral or a sentence, and how `two` reads when a digit is already on
screen. Filling the table now would be choosing the policy by writing 138 cells and calling the
result an inventory.

The inputs that *are* settled, so the next phase starts from them rather than from the strings:

- **Phase 7.4A §5** — the per-message table: key, English `one`/`other`, current Arabic, counted
  noun, the grammatical identity of each current form, and the per-message note.
- **Phase 7.4A §3** — the attested plural for every counted noun, and three attested
  zero-constructions.
- **Phase 7.4A §4** — the verified category boundaries, including `103 → few` and
  `100–102 → other` while `111 → many`.
- **This report §5** — the counted noun for five of the six that lacked one.

## 8. English semantics

**Unchanged.** §11 permits adding a noun to English *only* when an approved product decision
identifies what the count represents. Decision B verified five nouns from the repository, but
verifying what a number counts is not the same as approving a wording change — and §4 is explicit
that English must not be rewritten to make Arabic easier. So `notifications.unreadCount` still reads
`{count} unread`, and the recommendation to name the noun is carried to §16 as an action for a person.

## 9. Type and architecture impact

**None.** `LeafPaths`, `PluralPaths`, `MessageKey`, `Translator`, `translate()`, `useTranslate()`,
`getTranslator()` and `selectPluralForm()` are byte-identical to Phase 7.4. No implementation defect
was found, so §6's prohibition holds and nothing was touched.

## 10. Tests

**45 in `@edms/i18n`**, up from 43. The two added are §13's regression guard, in both directions:

- **Reversion** was already covered ("every message interpolating `{count}` is a plural message").
- **Silent progress** is the new one: a tripwire asserting that **exactly 23** Arabic messages still
  answer every category from a single `other` form. When somebody completes one, this test *fails on
  purpose*, and its message says what to do — remove that key from the count **and add six wording
  assertions for it**, rather than widen the expectation.
- The mirror assertion for English: no English plural may be left answering every category from one
  form, which is what makes the Arabic number meaningful rather than a coincidence.

It is not a generalised Arabic grammar engine, per §13.

**A catch worth recording.** The first version of that guard cast `PluralMessage` to
`Record<string, unknown>`. Vitest passed — it strips types — and `pnpm typecheck` **failed**. Had I
reported the suite as the gate, I would have reported a green that was not green. Fixed by counting
forms through `Object.entries` instead of a cast.

**No Arabic wording tests were added**, because there is no approved wording to assert. Writing them
against the current `other` fallback would pin the thing that must change.

## 11. RTL and browser verification

**NOT APPLICABLE for what changed; NOT RUN for Arabic wording.**

This phase changed one test file and added documentation. No rendered output changed in either
language — confirmed by the visual suite (83 passed, no baseline moved) and by the running
application (E2E 27 passed). §14 and §15's matrix — Arabic, RTL, 390px, desktop, light and dark —
belongs to the phase that lands approved copy, because every observation would have to be
re-established afterwards.

The reachability finding from Phase 7.4A stands and is confirmed by this phase's trace: **21 of 23
are reachable in normal workflows**; `bulk.result.refusedHint`, `blockedHint` and `failedHint` render
only when a document bulk operation partially fails. §14 forbids fabricating that state, and the
current E2E suite does not produce it naturally, so those three will be verified at the translation
layer and classified separately when the time comes.

## 12. Remaining limitations

1. **ARABIC POLICY DECISION REQUIRED** — the blocker, unchanged in substance but now backed by a
   proven exhaustive search rather than an inference.
2. **`bulk.bar.selected` — NOUN DECISION REQUIRED**, for the architectural reason in §5.
3. **23 messages still ARABIC REVIEW REQUIRED.**
4. **English nouns not added** to the five verified messages — deliberately, per §8.
5. `bulk.result.*` has no browser surface in the current E2E suite.
6. Everything §16 places out of scope — `report-pdf.ts`, tenant-editable notification templates —
   remains untouched.

## 13. Files changed

```
packages/i18n/src/plural.spec.ts   +2 tests (the §13 tripwire, both directions)
docs/reports/phase-7.4b-arabic-pluralization-completion.md   NEW
docs/README.md                     index entry
```

**No Arabic string, no English string, no type, no translator and no selection logic changed.**

## 14. Gates

| Gate | Result | Note |
| --- | --- | --- |
| `pnpm format` | **PASS** | |
| `pnpm lint` | **PASS** | 0 errors; 7 pre-existing warnings |
| `pnpm typecheck` | **PASS** | **13/13** — and it caught a defect the test run did not (§10) |
| i18n tests | **PASS** | **45** (was 43) |
| web unit tests | **PASS** | 142 |
| API tests | **PASS** | 645, 1 skipped — run, not assumed, since the API shares the catalogue |
| `pnpm build` | **PASS** | 9/9 |
| `pnpm verify:styles` | **PASS** | 10/10 |
| visual | **PASS** | 83, no baseline moved — expected; nothing renders differently |
| responsive | **PASS** | included in the visual project |
| e2e `signing.e2e.spec.ts` | **NOT RUN** | Nothing reaching the running application changed — one test file and two documents. Phase 7.4A ran it on this code and it passed 27/27; that result is **not** claimed as this phase's |
| e2e `recovery.e2e.spec.ts` | **NOT RUN** | as above; env-gated on `DR_DEST_ADMIN_URL` regardless |
| integration | **NOT RUN** | No API, schema or contract behaviour changed; the API typechecks and its 645 unit tests pass |

## 15. Evidence classification

**VERIFIED** — the absence of any documented numeral-agreement convention, across 105 documents,
`ARCHITECTURE.md`, the i18n package and the catalogue's comments, by reproducible search; the counted
noun for five of the six ambiguous messages, each traced producer → contract → renderer by file and
line; that `BulkResultDialog` has exactly one consumer; that `ResourceList` is shared across the
document library and 25+ administration screens.

**IMPLEMENTED** — two regression tests.

**ARABIC REVIEW REQUIRED** — all 23 messages.

**BLOCKED** — Decision A (no policy exists to cite); `bulk.bar.selected`'s noun (polymorphic by
design).

**NOT RUN** — E2E and integration, with reasons; Arabic RTL verification, deferred to the phase that
lands copy.

**Not claimed** — nothing about Arabic linguistic correctness. Five verified *nouns* are not five
verified translations.

## 16. Final status and the exact decisions required

**BLOCKED.**

Two decisions, both for a person, in order:

**Decision A — the numeral-agreement policy.** For an Arabic-speaking reviewer with product
authority. The question, precisely: when a rendered digit sits beside a counted noun in Munaxa Docs,
which construction does the product use —

- `{count}` + accusative singular (`{count} صفًا`, as `admin.grid.rowCount` does today),
- `{count}` + `من` + plural (`{count} من الأرقام`, as `admin.numbering.reservations.held` does),
- `{count}` + plural (`{count} أشخاص`, as `admin.approvalGroups.memberCount` does),
- or label/value (`المحدَّد: {count}`, as `bulk.bar.selected` does)?

And within the chosen construction: **how does `two` read when the digit is already on screen**, and
is `zero` a numeral or a sentence? One decision, six forms, 23 messages.

**Decision B(vi) — what `bulk.bar.selected` counts.** For a product owner. Pass the resource name
into the message so each list supplies its own noun; keep the label/value form; or accept an
invariant. §5 sets out the three.

**Then**, and only then: complete the 23 against the policy using Phase 7.4A §3's attested
vocabulary and §5's per-message notes; add six wording assertions per message (the tripwire in §10
will fail until the count is updated, which is its purpose); and run the RTL matrix over the 21
reachable messages.
