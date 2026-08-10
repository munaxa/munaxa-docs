# Phase 7.4A — Arabic Pluralization Review & Completion

**Status: BLOCKED on linguistic completion. 23 of 23 messages remain ARABIC REVIEW REQUIRED.**

This is not the outcome I set out to reach, and it is not "ran out of evidence" either. The review
found a **single, uniform blocker that applies to every one of the 23 messages**, and a house-policy
question that has to be answered before any message-by-message review would be worth doing. Both are
described precisely enough below that a reviewer can start from them rather than from the strings.

What this phase does deliver: the complete review package, the Arabic category boundaries verified
against the runtime (including two that are counter-intuitive), 20 new tests pinning them, and three
findings about the existing Arabic that the inventory surfaced.

---

## 1. Scope

The 23 plural messages Phase 7.4 migrated, each currently carrying only `other` — the single form the
catalogue shipped before plural messages existed. Nothing else. The architecture is untouched: no
change to `LeafPaths`, `PluralPaths`, `MessageKey`, `Translator`, `translate()`, `useTranslate()`,
`getTranslator()` or the selection logic, because nothing in the review proved the architecture
incapable of representing a correct message. **The mechanism was never the problem.**

## 2. The blocker, stated once because it is the same one 23 times

Arabic needs a `two` form. A `two` form in these messages is the construction `{count}` + dual noun —
a **digit beside a dual**.

The catalogue writes duals, and writes them well. Seven are attested, with correct case selection
between the nominative and oblique:

```
'تتطلب مقارنة البيانات الوصفية أن تكون المراجعتان منشورتين…'   the two revisions … published
'لا تغييرات في البيانات الوصفية بين اللقطتين المنشورتين.'      between the two snapshots
'مقارنة النص غير متاحة لهاتين المراجعتين.'                      for these two revisions
'…سيصبح للرقم صورتان مكتوبتان.'                                 two written forms
'التحقق بخطوتين'                                                two-step verification
'…ويُسجَّل الاسمان معًا.'                                        both names are recorded
```

**Not one of them puts a digit next to the dual.** Every attested dual is a bare dual, where the
duality is carried by the morphology alone.

So the question a `two` form has to answer — does the badge read `2 صفان`, which is redundant because
the dual already means two; or `صفان`, which leaves `{count}` unused; or `2 صف`, which abandons the
dual — is a **house convention this product has never set**. It is not recoverable from the
repository, it is the same question for all 23 messages, and guessing it once would guess it 23
times.

That is the whole of the blocker. It is not about vocabulary: the vocabulary is there (§3).

## 3. Existing Arabic terminology evidence

Every counted noun's plural **is** attested in the catalogue, so the lexical half of the work is
already decided and a reviewer should not re-open it:

| Counted noun | Singular | Plural attested | Occurrences |
| --- | --- | --- | --- |
| row | صف | **صفوف** | 28 / 2 |
| event | حدث | **أحداث** | 13 / 3 |
| document | مستند | **مستندات** | 30 / 12 |
| document (alt) | وثيقة | **وثائق** | 45 / 30 |
| file | ملف | **ملفات** | 29 / 5 |
| role | دور | **أدوار** | 10 / 4 |
| person | شخص | **أشخاص** | 25 / 7 |
| item | عنصر | **عناصر** | 7 / 2 |
| number | رقم | **أرقام** | 19 / 11 |
| holiday | عطلة | **عطلات** | 2 / 3 |
| decision | قرار | **قرارات** | 10 / 1 |
| result | نتيجة | **نتائج** | 9 / 3 |
| time (occurrence) | مرة | **مرات** | 18 / 1 |

Zero-style constructions are attested too, which matters for the `zero` form:

```
'لا توجد صفوف مطابقة لعوامل التصفية هذه.'     no rows matching these filters
'لا توجد نتائج مطابقة لهذا البحث'              no results matching this search
'لا يوجد غير مقروء'                             nothing unread
```

The third is the closest thing in the repository to a completed `zero` form — it is the exact
negation of `notifications.unreadCount`'s `{count} غير مقروء`. It is still not a decision I can take:
those three are **empty-state sentences on their own surfaces**, and whether a *counter* at zero
should switch to a sentence or stay a numeral (`0 صف`) is the same house-convention question as §2.

## 4. Arabic plural category analysis — VERIFIED

Every number §6 names, checked against `Intl.PluralRules('ar')` at runtime and now pinned by tests:

| Category | Numbers |
| --- | --- |
| `zero` | 0 |
| `one` | 1 |
| `two` | 2 |
| `few` | 3, 4, 5, 6, 10, **103** |
| `many` | 11, 12, 99, 111 |
| `other` | 100, 101, 102 |

Two are worth a reviewer's attention because they are easy to get wrong:

- **103 is `few`.** The rule reads the last two digits, so 103, 1003 and 10 003 take the same form as
  3. A `few` form written as "three to ten" is also the form for 103.
- **100, 101 and 102 are `other`, but 111 is `many`.** The boundary is not "a hundred and above".

## 5. The 23-message inventory

`⟨noun⟩` names what is counted; `plural attested` is from §3. **Every row's status is
ARABIC REVIEW REQUIRED**, for the reason in §2 plus its own note.

| # | Key | English (`one` / `other`) | Current Arabic `other` | ⟨noun⟩ | Per-message note |
| --- | --- | --- | --- | --- | --- |
| 1 | `admin.grid.rowCount` | `{count} row` / `{count} rows` | `{count} صفًا` | صف → صفوف | Current form is the **accusative *tamyīz***, correct for 11–99. It is in `other`, which serves 100+. See §6. |
| 2 | `reports.rowCount` | same as #1 | `{count} صف` | صف → صفوف | **Same concept, different form** from #1. See §6. |
| 3 | `audit.export.events` | `{count} event` / `events` | `{count} حدثاً` | حدث → أحداث | 11–99 form in the `other` slot. |
| 4 | `dashboard.admin.blobs` | `{count} file` / `files` | `{count} ملفًا` | ملف → ملفات | 11–99 form in the `other` slot. |
| 5 | `admin.settings.searchRebuildSummary` | `{count} document indexed, started {startedAt}.` | `تمت فهرسة {count} مستندًا، بدأت {startedAt}.` | مستند → مستندات | 11–99 form; also carries a second variable. |
| 6 | `admin.approvalGroups.memberCount` | `{count} person` / `people` | `{count} أشخاص` | شخص → أشخاص | Uses the **3–10 plural**, a third strategy again. |
| 7 | `admin.calendars.holidayCount` | `{count} holiday` / `holidays` | `{count} عطلات` | عطلة → عطلات | 3–10 plural. |
| 8 | `delegations.useCount` | `{count} decision` / `decisions` | `{count} قرارات` | قرار → قرارات | 3–10 plural. |
| 9 | `admin.notificationTemplates.bounces` | `{count} refusal` / `refusals` | `{count} حالات رفض` | حالة رفض | Compound noun; plural of the head only. |
| 10 | `preview.matches` | `{count} match` / `matches` | `{count} نتيجة` | نتيجة → نتائج | Bare singular. |
| 11 | `documents.upload.fileCount` | `File {count} document` / `documents` | `حفظ {count} وثيقة` | وثيقة → وثائق | A **button label**, not a sentence — length matters at 390px. |
| 12 | `documents.upload.duplicateWarning` | `…already filed {count} time(s)…` | `…محفوظ بالفعل {count} مرة…` | مرة → مرات | Counts occurrences, not objects. |
| 13 | `admin.numbering.reservations.held` | `{count} number reserved.` | `تم حجز {count} من الأرقام.` | رقم → أرقام | Uses the **`من` + plural** partitive, a fourth strategy. |
| 14 | `admin.list.inUseByTypes` | `Used by {count} document type. Change it first.` | `مستخدم في {count} من أنواع المستندات. عدّلها أولًا.` | نوع مستند | `من` partitive; second sentence's pronoun (`عدّلها`) also agrees with number. |
| 15 | `admin.list.inUseByChildren` | `It has {count} item inside it.` | `يحتوي على {count} من العناصر.` | عنصر → عناصر | `من` partitive. |
| 16 | `admin.roles.inUseByMembers` | `{count} person holds this role…` | `يحمل هذا الدور {count} من الأشخاص. أزِله عنهم أولًا.` | شخص → أشخاص | `من` partitive; **verb `يحمل` and pronoun `عنهم` both agree with the count.** |
| 17 | `auth.mfaEnrolledHint` | `…{count} unused recovery code(s) left.` | `…لديك {count} من رموز الاسترداد غير المستخدمة.` | رمز استرداد | `من` partitive; adjective `غير المستخدمة` agrees too. |
| 18 | `notifications.unreadCount` | `{count} unread` (invariant) | `{count} غير مقروء` | ⟨implicit: notifications⟩ | English invariant, **Arabic is not**: `غير مقروء` is a masculine singular adjective. `لا يوجد غير مقروء` is attested as the zero sentence. |
| 19 | `dashboard.admin.unreferenced` | `{count} unreferenced` (invariant) | `{count} بلا مرجع` | ⟨implicit: files⟩ | Same shape as #18. |
| 20 | `bulk.bar.selected` | `{count} selected` (invariant) | `المحدَّد: {count}` | ⟨implicit: documents⟩ | **Restructured as a label** (`Selected: N`), which sidesteps agreement entirely — possibly the house answer for #18–#22. |
| 21 | `bulk.result.refusedHint` | `{count} was/were refused: …` | `رُفِض {count} لعدم امتلاكك صلاحية…` | ⟨implicit⟩ | Verb `رُفِض` is masculine singular; Arabic inanimate plurals normally take feminine singular agreement. **See §7 — the English does not name the noun.** |
| 22 | `bulk.result.blockedHint` | `{count} was/were blocked…` | `مُنِع {count} بقاعدة…` | ⟨implicit⟩ | As #21. |
| 23 | `bulk.result.failedHint` | `{count} failed unexpectedly…` (invariant) | `أخفق {count} بشكل غير متوقَّع…` | ⟨implicit⟩ | As #21. |

## 6. Findings the inventory surfaced

**Finding 1 — the catalogue uses four different numeral-agreement strategies, and two of them for
the same noun.** Across the 23: the 11–99 accusative *tamyīz* (#1, 3, 4, 5), the 3–10 plural (#6, 7,
8), the bare singular (#2, 10, 11, 12), and the `من` partitive (#13–#17). **`admin.grid.rowCount`
renders `{count} صفًا` while `reports.rowCount` renders `{count} صف` — the same word, counted the
same way, on two screens.** A reviewer who works message by message will reproduce this inconsistency
in six times as many places. **The house policy has to be decided first**, and that decision is the
single highest-value next action in this report.

**Finding 2 — five messages count something the English never names** (#18–#23, and #20 has already
been rewritten in Arabic to avoid the problem). "{count} were refused" leaves the noun implicit;
English can, Arabic cannot, because the verb and any adjective must agree in gender and number with
the thing counted. §5 and §9 both say to flag this rather than rewrite the English catalogue, so it
is flagged: **the English is ambiguous, and completing the Arabic requires naming the noun.**
Whether "3 documents were refused" is the right English is a product decision, not a translation one.

**Finding 3 — `bulk.bar.selected` may already contain the house answer.** Its Arabic is
`المحدَّد: {count}` — restructured from a counted phrase into a *label with a value*, which needs no
agreement at all and is invariant across all six categories. If that is the convention the product
wants for badges and counters, #18, #19 and possibly #21–#23 have a template already in the
repository. Offered as an alternative supported by repository evidence, per §14 — **not applied**,
because reading one string as a policy is exactly the inference this phase is refusing to make.

## 7. Why nothing was completed

I looked for a message I could finish honestly. The closest was #18, `notifications.unreadCount`:
English is invariant, and the zero sentence is attested verbatim. It still needs `two`, `few` and
`many` forms of `غير مقروء`, which is a masculine singular adjective whose agreement depends on the
implicit noun the English never names (Finding 2) — and it needs the digit-plus-dual convention
(§2). Three unresolved decisions on the easiest of the 23.

Producing fluent Arabic for the other 22 would have been mechanically easy and would have looked
finished. §14 and §21 both forbid it, and they are right to: a grammatically wrong Arabic string
behind a passing build is worse than a marked one, because nobody looks again.

**A correction to my own work in this phase.** My first search for attested duals used
`grep -oE "[ء-ي]+(ان|ين)\b"` and returned nothing, and I was about to report that the catalogue
contains no duals at all. `\b` does not work at an Arabic word boundary in POSIX regex, so the search
was a false negative. Checking the pattern against a known positive caught it, and the real search
found seven duals — which changed the finding from "the product cannot write duals" to the much
narrower and more useful "the product has never written a digit beside one". The absence of evidence
was an artefact of my tool, and the conclusion in §2 rests on the corrected search.

## 8. Type and architecture impact

**None.** No file under `packages/i18n/src` changed except the Arabic catalogue's header comment and
the test suite. `LeafPaths`, `PluralPaths`, `MessageKey`, `Translator`, `translate()`,
`useTranslate()`, `getTranslator()` and `selectPluralForm()` are byte-identical to Phase 7.4.

The architecture was checked against the requirement rather than assumed adequate: six optional
category fields, `other` required, selection delegated to `Intl.PluralRules`. Every form a reviewer
could write — including a `zero` that is a full sentence and a `two` that omits `{count}` — is
representable today. **Nothing in the review argues for changing it.**

## 9. English

**Unchanged.** Finding 2 identifies a genuine semantic gap in five English messages (the noun is not
named). §9 says to stop and report rather than silently rewrite, so it is reported in §6 and listed
in §14 as an action, and the English catalogue is untouched.

## 10. Unit tests

**43 in `@edms/i18n`, up from 26.** The 20 added by this phase:

- **16 category-boundary assertions** for Arabic — 0, 1, 2, 3, 4, 5, 6, 10, 11, 12, 99, 100, 101,
  102, 103, 111 — each pinned to the category `Intl.PluralRules('ar')` actually returns. The two
  counter-intuitive ones (103 → `few`, 100–102 → `other` while 111 → `many`) are the reason this is a
  table rather than a sentence in a comment.
- **A safety assertion for the pending state**: every one of those counts, in Arabic, renders a
  string containing the number and not the message key. This is what makes the incomplete state safe
  to ship — no category can produce an empty string or a key while review is outstanding.

Tests were **not** written asserting Arabic wording, because there is no reviewed Arabic wording to
assert. Writing them against the current `other` fallback would pin the very thing that needs to
change.

## 11. Browser and RTL verification

**NOT APPLICABLE for what this phase changed, and NOT RUN for Arabic rendering.** Both stated plainly
rather than folded together:

- This phase changed a doc comment and a test file. **No rendered output changed**, in either
  language — which the visual suite confirms (83 passed, no baseline moved) and the E2E suite
  confirms in the running application (27 passed).
- Arabic rendering at 390px, in RTL, in both themes, across the 23 messages was **not carried out**.
  It would be an inspection of the *pre-existing* wording, and the wording is about to change: every
  finding would have to be re-established after review. §13's inspection belongs in the phase that
  lands the reviewed copy, and is listed in §14 as its final step.

Of the 23, **21 are reachable in a UI**; #21–#23 (`bulk.result.*`) render only after a bulk operation
that partially fails, which the E2E suite does not currently produce. Noted for whoever does the
Arabic pass.

## 12. Remaining limitations

1. **ARABIC REVIEW REQUIRED — 23 of 23.** The whole point of the phase, unresolved for one uniform
   reason and a set of per-message notes.
2. **The house numeral-agreement policy is unset** (Finding 1) and blocks consistent review.
3. **Five English messages do not name what they count** (Finding 2).
4. **`bulk.result.*` has no browser surface** in the current E2E suite.
5. Everything §16 of the brief placed out of scope — `report-pdf.ts`, tenant-editable notification
   templates — remains untouched and out of scope.

## 13. Files changed

```
packages/i18n/src/catalogues/ar.ts      header comment only — points at this report; no wording changed
packages/i18n/src/plural.spec.ts        +20 tests (Arabic boundaries, pending-state safety)
docs/reports/phase-7.4a-arabic-pluralization-review.md   NEW
docs/README.md                          index entry
```

**No Arabic string was added, removed or altered.**

## 14. Gates

| Gate | Result | Note |
| --- | --- | --- |
| `pnpm format` | **PASS** | |
| `pnpm lint` | **PASS** | 0 errors; 7 pre-existing warnings |
| `pnpm typecheck` | **PASS** | **13/13** |
| i18n tests | **PASS** | **43** (was 26) |
| web unit tests | **PASS** | 142 |
| API tests | **PASS** | 645, 1 skipped — run rather than assumed, since the API shares the catalogue |
| `pnpm build` | **PASS** | 9/9 |
| `pnpm verify:styles` | **PASS** | 10/10 |
| visual + responsive | **PASS** | 83, no baseline changed — expected, nothing rendered differently |
| **e2e `signing.e2e.spec.ts`** | **PASS** | **27 passed, 0 failed**, real API + Redis + PostgreSQL + production build + Chromium |
| e2e `recovery.e2e.spec.ts` | **FAIL** | env-gated on unset `DR_DEST_ADMIN_URL`; pre-existing since Phase 7.1B, unrelated, not skipped or weakened |
| integration | **NOT RUN** | No API, schema or contract behaviour changed; the API typechecks and its 645 unit tests pass. Reported as not run rather than inherited |

## 15. Evidence classification

**VERIFIED** — the Arabic category boundaries for all 16 numbers in §6 of the brief, against the
runtime; that every category renders a non-empty, non-key string while review is pending; that the
architecture can represent every form a reviewer might write; that no rendered output changed.

**IMPLEMENTED** — 20 tests; the catalogue header pointing at this review package.

**ARABIC REVIEW REQUIRED** — all 23 messages, itemised in §5 with the counted noun, the attested
plural, the current form's grammatical identity, and the specific question.

**KNOWN LIMITATION** — no house numeral-agreement policy; five English messages that do not name
their noun; `bulk.result.*` unreachable in the E2E suite.

**BLOCKED** — linguistic completion of all 23, on the digit-plus-dual convention (§2).

**NOT RUN** — Arabic RTL browser inspection, deliberately deferred to the phase that lands reviewed
copy.

**Not claimed:** nothing here is called linguistically VERIFIED. `Intl.PluralRules` working, the
catalogue compiling, the typecheck passing and the browser rendering RTL are — as §17 says — not
evidence about Arabic.

## 16. Final status

**BLOCKED.** Not PARTIALLY COMPLETE: partial completion would mean some messages were finished, and
none were. The mechanism and the English remain COMPLETE from Phase 7.4; Arabic is exactly where that
phase left it, now with the review done and the obstacle named.

## 17. Exact next action for every unresolved message

**One decision unblocks all 23.** In order:

1. **Set the numeral-agreement policy** (Finding 1). Specifically: how does a rendered digit sit
   beside a counted noun in this product — `{count}` + accusative singular (as `صفًا` does), `{count}`
   + `من` + plural (as `من الأرقام` does), or the label form (`المحدَّد: {count}`)? And within it, how
   does `two` read when the digit is already on screen? This is one decision by one Arabic-speaking
   reviewer, and it determines all six forms of all 23.
2. **Name the noun in the five ambiguous English messages** (#18–#23, Finding 2) — a product
   decision, taken before translation, not during it.
3. **Complete the 23** against the policy, using the attested vocabulary in §3 (which the reviewer
   should not need to re-derive) and the per-message notes in §5. Delete each
   `ARABIC REVIEW REQUIRED` comment as its message is completed — they are grep-able:
   `rg "ARABIC REVIEW REQUIRED" packages/i18n/src/catalogues/ar.ts`.
4. **Add wording assertions**, six per completed message, alongside the boundary tests already in
   `plural.spec.ts`.
5. **Then** run the Arabic RTL pass (§11) — 21 of the 23 are reachable in a UI; give
   `bulk.result.*` a partial-failure fixture or accept that it is verified at the translation layer
   only.
