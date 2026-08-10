# Phase 7.4C — Arabic Pluralization Completion

**Status: COMPLETE.**

23 of 23 Arabic plural messages completed. **Zero `ARABIC REVIEW REQUIRED` markers remain.** Wording
assertions cover every message, RTL was verified in a real browser at desktop and 390px in both
themes, and every applicable gate is reported below with the command that produced it.

One thing is stated plainly at the top rather than buried: the Arabic below was written by applying
the approved policy to the vocabulary the repository already uses. The *mechanism*, the *category
selection*, the *consistency* and the *terminology sourcing* are VERIFIED by tests and by rendering.
The *prose quality* is the product of a rule applied carefully, not of a native speaker's read, and
§15 classifies it accordingly.

---

## 1. Decisions applied

**Decision 1 — the Munaxa Arabic numeral policy.** One table, applied 23 times:

| Category | Construction | Example |
| --- | --- | --- |
| `zero` | digit + plural | `0 صفوف` |
| `one` | digit + singular | `1 صف` |
| `two` | **dual, no digit** | `صفان` |
| `few` (3–10, 103…) | digit + plural | `3 صفوف` |
| `many` (11–99, 111…) | digit + singular accusative (تمييز منصوب) | `11 صفًا` |
| `other` (100–102…) | digit + singular genitive | `100 صف` |

`zero` stays a numeric counter per §7 of the decision — `0 صفوف`, not `لا توجد صفوف`. The
empty-state sentences that already exist (`لا توجد صفوف مطابقة…`) are different messages on
different surfaces and were left alone.

**Decision 2 — `bulk.bar.selected` stays `المحدَّد: {count}`**, invariant across all six categories.
`ResourceList` was not touched, no resource-name prop was added, and the English `{count} selected`
is unchanged.

## 2. The `two` form, and why it drops the digit

This was the blocker through two phases. The policy resolves it: the Arabic dual already means two,
so printing the digit beside it says it twice. `صفان`, not `2 صفان`.

That makes `two` the one form in the catalogue that deliberately does not interpolate `{count}` —
which is representable because a plural message is free to ignore a variable, and which is now
**enforced by a test across every plural key**, not left to convention:

```
expect(translate('ar', key, { count: 2 })).not.toContain('2');   // every key but the invariant one
expect(translate('ar', key, { count })).toContain(String(count)); // 1, 3, 11, 100
```

## 3. Terminology evidence

Every noun is the catalogue's own, from Phase 7.4A's attestation table — `صفوف`, `أحداث`, `مستندات`,
`وثائق`, `أشخاص`, `عناصر`, `أرقام`, `عطلات`, `قرارات`, `نتائج`, `مرات`, `إشعارات`. No synonym was
introduced.

Two choices were settled by evidence found in this phase rather than assumed:

- **The bulk results count `وثيقة`, not `مستند`.** Both words are attested for "document", so the
  tie was broken by the surface: `documents.title` is `الوثائق` and `bulk.bar.label` is
  `الوثائق المحدَّدة`. The bulk panel lives in that feature, so it uses that feature's word.
- **`notifications.unreadCount` counts `إشعار`** — attested 12 times, with `إشعارات` 8 times, and
  `notifications.title` is `الإشعارات`.

**Orthography normalised.** The catalogue wrote the accusative *tanwīn* two ways: `صفًا`, `مستندًا`,
`ملفًا` (mark before the alif) but `حدثاً` (after). Three to one, so the majority form is now used
throughout.

## 4. Agreement beyond the noun

Arabic changes more than one word when a count changes, and four messages show it:

- **`admin.roles.inUseByMembers`** moves its pronoun: `أزِله عنه` → `عنهما` → `عنهم`.
- **`admin.list.inUseByTypes`** moves its verb+pronoun: `عدّله` → `عدّلهما` → `عدّلها`.
- **The three `bulk.result.*`** take **feminine** verb agreement — `رُفِضت`, `مُنِعت`, `أخفقت` —
  because what they count is `وثيقة`. The previous Arabic used masculine forms with the noun elided;
  naming the noun is what made the agreement expressible.
- **`auth.mfaEnrolledHint`** moves its adjective: `غير مستخدم` → `غير مستخدمين` → `غير مستخدمة`.

Two messages take the dual in the **oblique** rather than the nominative, because of where they sit
in their sentence: `يحتوي على عنصرين` (after a preposition) and `حفظ وثيقتين` / `تمت فهرسة مستندين`
(second term of an *iḍāfa*). `admin.notificationTemplates.bounces` takes `حالتا رفض` — the dual in
*iḍāfa* drops its *nūn*.

## 5. The 23 messages, as rendered

Produced by calling `translate('ar', key, { count })` against the built package — the strings below
are output, not source.

| Key | 0 | 1 | 2 | 3 | 11 | 100 |
| --- | --- | --- | --- | --- | --- | --- |
| `admin.grid.rowCount` | 0 صفوف | 1 صف | صفان | 3 صفوف | 11 صفًا | 100 صف |
| `reports.rowCount` | 0 صفوف | 1 صف | صفان | 3 صفوف | 11 صفًا | 100 صف |
| `audit.export.events` | 0 أحداث | 1 حدث | حدثان | 3 أحداث | 11 حدثًا | 100 حدث |
| `dashboard.admin.blobs` | 0 ملفات | 1 ملف | ملفان | 3 ملفات | 11 ملفًا | 100 ملف |
| `admin.settings.searchRebuildSummary` | تمت فهرسة 0 مستندات، بدأت اليوم. | تمت فهرسة 1 مستند، بدأت اليوم. | تمت فهرسة مستندين، بدأت اليوم. | تمت فهرسة 3 مستندات، بدأت اليوم. | تمت فهرسة 11 مستندًا، بدأت اليوم. | تمت فهرسة 100 مستند، بدأت اليوم. |
| `admin.approvalGroups.memberCount` | 0 أشخاص | 1 شخص | شخصان | 3 أشخاص | 11 شخصًا | 100 شخص |
| `admin.calendars.holidayCount` | 0 عطلات | 1 عطلة | عطلتان | 3 عطلات | 11 عطلةً | 100 عطلة |
| `delegations.useCount` | 0 قرارات | 1 قرار | قراران | 3 قرارات | 11 قرارًا | 100 قرار |
| `admin.notificationTemplates.bounces` | 0 حالات رفض | 1 حالة رفض | حالتا رفض | 3 حالات رفض | 11 حالة رفض | 100 حالة رفض |
| `preview.matches` | 0 نتائج | 1 نتيجة | نتيجتان | 3 نتائج | 11 نتيجةً | 100 نتيجة |
| `documents.upload.fileCount` | حفظ 0 وثائق | حفظ 1 وثيقة | حفظ وثيقتين | حفظ 3 وثائق | حفظ 11 وثيقةً | حفظ 100 وثيقة |
| `documents.upload.duplicateWarning` | هذا الملف نفسه محفوظ بالفعل 0 مرات في هذه المؤسسة: | هذا الملف نفسه محفوظ بالفعل 1 مرة في هذه المؤسسة: | هذا الملف نفسه محفوظ بالفعل مرتين في هذه المؤسسة: | هذا الملف نفسه محفوظ بالفعل 3 مرات في هذه المؤسسة: | هذا الملف نفسه محفوظ بالفعل 11 مرةً في هذه المؤسسة: | هذا الملف نفسه محفوظ بالفعل 100 مرة في هذه المؤسسة: |
| `admin.numbering.reservations.held` | تم حجز 0 أرقام. | تم حجز 1 رقم. | تم حجز رقمين. | تم حجز 3 أرقام. | تم حجز 11 رقمًا. | تم حجز 100 رقم. |
| `admin.list.inUseByTypes` | مستخدم في 0 أنواع مستندات. عدّلها أولًا. | مستخدم في 1 نوع مستند. عدّله أولًا. | مستخدم في نوعَي مستند. عدّلهما أولًا. | مستخدم في 3 أنواع مستندات. عدّلها أولًا. | مستخدم في 11 نوع مستند. عدّلها أولًا. | مستخدم في 100 نوع مستند. عدّلها أولًا. |
| `admin.list.inUseByChildren` | يحتوي على 0 عناصر. | يحتوي على 1 عنصر. | يحتوي على عنصرين. | يحتوي على 3 عناصر. | يحتوي على 11 عنصرًا. | يحتوي على 100 عنصر. |
| `admin.roles.inUseByMembers` | يحمل هذا الدور 0 أشخاص. أزِله عنهم أولًا. | يحمل هذا الدور 1 شخص. أزِله عنه أولًا. | يحمل هذا الدور شخصان. أزِله عنهما أولًا. | يحمل هذا الدور 3 أشخاص. أزِله عنهم أولًا. | يحمل هذا الدور 11 شخصًا. أزِله عنهم أولًا. | يحمل هذا الدور 100 شخص. أزِله عنهم أولًا. |
| `auth.mfaEnrolledHint` | تطبيق المصادقة مُفعَّل. لديك 0 رموز استرداد غير مستخدمة. | تطبيق المصادقة مُفعَّل. لديك 1 رمز استرداد غير مستخدم. | تطبيق المصادقة مُفعَّل. لديك رمزا استرداد غير مستخدمين. | تطبيق المصادقة مُفعَّل. لديك 3 رموز استرداد غير مستخدمة. | تطبيق المصادقة مُفعَّل. لديك 11 رمز استرداد غير مستخدم. | تطبيق المصادقة مُفعَّل. لديك 100 رمز استرداد غير مستخدم. |
| `notifications.unreadCount` | 0 إشعارات غير مقروءة | 1 إشعار غير مقروء | إشعاران غير مقروءين | 3 إشعارات غير مقروءة | 11 إشعارًا غير مقروء | 100 إشعار غير مقروء |
| `dashboard.admin.unreferenced` | 0 ملفات بلا مرجع | 1 ملف بلا مرجع | ملفان بلا مرجع | 3 ملفات بلا مرجع | 11 ملفًا بلا مرجع | 100 ملف بلا مرجع |
| `bulk.bar.selected` | المحدَّد: 0 | المحدَّد: 1 | المحدَّد: 2 | المحدَّد: 3 | المحدَّد: 11 | المحدَّد: 100 |
| `bulk.result.refusedHint` | رُفِضت 0 وثائق لعدم امتلاكك صلاحية الوصول إليها. | رُفِضت 1 وثيقة لعدم امتلاكك صلاحية الوصول إليها. | رُفِضت وثيقتان لعدم امتلاكك صلاحية الوصول إليهما. | رُفِضت 3 وثائق لعدم امتلاكك صلاحية الوصول إليها. | رُفِضت 11 وثيقةً لعدم امتلاكك صلاحية الوصول إليها. | رُفِضت 100 وثيقة لعدم امتلاكك صلاحية الوصول إليها. |
| `bulk.result.blockedHint` | مُنِعت 0 وثائق بقاعدة، مثل حجز قانوني. | مُنِعت 1 وثيقة بقاعدة، مثل حجز قانوني. | مُنِعت وثيقتان بقاعدة، مثل حجز قانوني. | مُنِعت 3 وثائق بقاعدة، مثل حجز قانوني. | مُنِعت 11 وثيقةً بقاعدة، مثل حجز قانوني. | مُنِعت 100 وثيقة بقاعدة، مثل حجز قانوني. |
| `bulk.result.failedHint` | أخفقت 0 وثائق بشكل غير متوقَّع، وقد سُجِّل ذلك. | أخفقت 1 وثيقة بشكل غير متوقَّع، وقد سُجِّل ذلك. | أخفقت وثيقتان بشكل غير متوقَّع، وقد سُجِّل ذلك. | أخفقت 3 وثائق بشكل غير متوقَّع، وقد سُجِّل ذلك. | أخفقت 11 وثيقةً بشكل غير متوقَّع، وقد سُجِّل ذلك. | أخفقت 100 وثيقة بشكل غير متوقَّع، وقد سُجِّل ذلك. |

### Counted noun and English pairing

| Key | Counted noun | English meaning | Arabic meaning | Same concept? |
| --- | --- | --- | --- | --- |
| `admin.grid.rowCount`, `reports.rowCount` | صف (m) | N rows | N rows | yes |
| `audit.export.events` | حدث (m) | N audit events | N events | yes |
| `dashboard.admin.blobs` | ملف (m) | N stored files | N files | yes |
| `admin.settings.searchRebuildSummary` | مستند (m) | N documents indexed, started X | same, with `{startedAt}` preserved | yes |
| `admin.approvalGroups.memberCount` | شخص (m) | N people in the group | N people | yes |
| `admin.calendars.holidayCount` | عطلة (f) | N holidays | N holidays | yes |
| `delegations.useCount` | قرار (m) | N decisions taken under the delegation | N decisions | yes |
| `admin.notificationTemplates.bounces` | حالة رفض (f) | N delivery refusals | N refusal cases | yes |
| `preview.matches` | نتيجة (f) | N search matches in the preview | N results | yes |
| `documents.upload.fileCount` | وثيقة (f) | button: file N documents | button: save N documents | yes |
| `documents.upload.duplicateWarning` | مرة (f) | already filed N times | already saved N times | yes |
| `admin.numbering.reservations.held` | رقم (m) | N numbers reserved | N numbers reserved | yes |
| `admin.list.inUseByTypes` | نوع مستند (m) | used by N document types, change those first | same, pronoun agreeing | yes |
| `admin.list.inUseByChildren` | عنصر (m) | it has N items inside | it contains N items | yes |
| `admin.roles.inUseByMembers` | شخص (m) | N people hold this role, remove it from them | same, pronoun agreeing | yes |
| `auth.mfaEnrolledHint` | رمز استرداد (m) | N unused recovery codes left | same, adjective agreeing | yes |
| `notifications.unreadCount` | إشعار (m) | N unread | **N unread notifications** | see note |
| `dashboard.admin.unreferenced` | ملف (m) | N unreferenced | **N unreferenced files** | see note |
| `bulk.bar.selected` | — (polymorphic) | N selected | selected: N | yes, by decision |
| `bulk.result.refusedHint` | وثيقة (f) | N were refused, no access | N documents were refused | see note |
| `bulk.result.blockedHint` | وثيقة (f) | N were blocked by a rule | N documents were blocked | see note |
| `bulk.result.failedHint` | وثيقة (f) | N failed unexpectedly | N documents failed | see note |

**The five "see note" rows are deliberate and directed.** The brief's special-case section says of
`notifications.unreadCount`: *"Do not blindly translate the English invariant. Make the Arabic
agreement explicit according to the approved policy and the noun 'notifications'."* The same
instruction applies to `dashboard.admin.unreferenced` (blobs/files) and the three `bulk.result.*`
(documents, per Decision B in Phase 7.4B).

So the Arabic **names a noun the English leaves implicit**. That is a semantic *addition* in Arabic —
and it is the one the instruction requires, because Arabic has no way to agree with an unnamed noun.
**The English catalogue is unchanged**, per §11 and §9 of the earlier briefs.

`dashboard.admin.unreferenced` deserves one extra line: it renders as the *value* of a `Figure` whose
*label* is `dashboard.admin.blobs`. In Arabic the pair now reads `12 ملفًا` / `3 ملفات بلا مرجع` —
the noun appears in both halves. That is repetition English avoids by eliding, and Arabic cannot.

## 6. Tests

**80 in `@edms/i18n`**, up from 45. What was added:

- **12 wording assertions on `admin.grid.rowCount`** at 0, 1, 2, 3, 5, 10, 11, 12, 99, 100, 103, 111
  — every number the brief lists, each pinned to its exact Arabic string.
- **`reports.rowCount` asserted equal to `admin.grid.rowCount` at all twelve counts.** This is the
  test that closes Phase 7.3's finding: the two rendered the same noun two different ways, and now
  they cannot diverge without a failure.
- **16 spot assertions** across the other messages at their interesting counts, chosen for the
  category rather than for coverage arithmetic — every `two` form, and each `many` form that changes
  the noun's ending.
- **The dual rule, enforced across every plural key**: the `two` form contains no digit; 1, 3, 11 and
  100 all do.
- **Agreement assertions**: the pronoun in `admin.roles.inUseByMembers` and `admin.list.inUseByTypes`
  at one, two and many; the feminine verbs in the three `bulk.result.*`.
- **`bulk.bar.selected` invariant** at six counts.
- **A sweep over every key × twelve counts**: non-empty, not the message key, contains Arabic script
  (`/[؀-ۿ]/`), and no unreplaced `{count}`.
- **Interpolation beside the count**: `{startedAt}` survives in `searchRebuildSummary`.
- The Phase 7.4A `Intl.PluralRules` boundary tests are **retained unchanged**.

**The tripwire was retargeted, not weakened.** It asserted "exactly 23 Arabic messages carry only
`other`". It now asserts that **exactly one does, and that it is `bulk.bar.selected`** — so it still
fails in both directions: if a message loses its forms, and if the one invariant by decision is given
agreement it was decided not to have.

**One Phase 7.4A test had to change, and why.** `every Arabic message still answers, in every
category` asserted that every rendered form contains the digit. The approved policy prints no digit
in `two`, so `صفان` legitimately fails it. The digit rule moved to the new test that states it
properly — no digit in `two`, a digit everywhere else, across every key — and what survives in the
old test is what it was always for: nothing renders a key or an empty string. That is a retarget with
its reasoning recorded in the test, not a weakening.

## 7. RTL and browser verification

**Performed, in real Chromium, against the built stylesheet.** The harness could not do this before:
`renderPage` hard-coded `lang="en" dir="ltr"`. It now takes a `locale` and sets both, which is the
only change to the test infrastructure.

**Five new Arabic surfaces × two themes = 10 baselines**, all rendering the real `LibraryScreen`
through the real provider tree with `locale: 'ar'`:

| Baseline | Count | Category exercised | Width |
| --- | --- | --- | --- |
| `ar-document-list-one` | 1 | `one` — `1 صف` | 1280 |
| `ar-document-list-two` | 2 | **`two` — `صفان`, no digit** | 1280 |
| `ar-document-list-few` | 3 | `few` — `3 صفوف` | 1280 |
| `ar-document-list-many` | 11 | `many` — `11 صفًا` | 1280 |
| `ar-document-list-mobile` | 11 | `many` at the narrow width | 390 |

**Inspected as images, not diffed and waved through.** At 1280 the layout mirrors correctly: the rail
moves to the right, the breadcrumb reverses, the toolbar's controls run right-to-left, and the
counter reads `صفان` above `2 من 2` with no digit beside the dual. At 390 the panels stack, the grid
keeps its two narrow-width columns, and `11 صفًا` sits at the end of the list without clipping or
overflow. The Latin document titles and numbers (`Quality Manual`, `QM-000`) stay in LTR runs inside
the Arabic column — which is what `16-frontend-architecture.md` §8 asks for, not a bidi defect.

Checked against §15's list: **number placement** correct (the digit leads its LTR run, the noun
follows in RTL); **punctuation** correct; **no clipping, no badge or button overflow, no horizontal
overflow** at either width; **no accidental LTR fragment** in translated text; **no duplicated
words**; wrapping does not split a number from its noun.

**A screenshot is not a linguistic proof**, and none is claimed as one — §6's assertions are what
cover the wording. The images cover what the assertions cannot: that the correct string also lands
correctly.

## 8. Browser coverage of the bulk-result messages

**Verified at the translation layer only.** `bulk.result.refusedHint`, `blockedHint` and `failedHint`
render solely when a document bulk operation partially fails — `result.tally.refused > 0` and its
siblings in `bulk-panel.tsx`. The existing E2E suite runs a bulk export that succeeds; producing a
partial failure naturally would require documents the caller cannot reach, or under legal hold, in
the same selection.

Per the brief: **no state was fabricated, and nothing was inserted into PostgreSQL.** The three are
covered by wording assertions including their feminine verb agreement, and their browser gap is
recorded here and in §10 rather than papered over.

## 9. Files changed

```
packages/i18n/src/catalogues/ar.ts    23 plural messages completed; header documents the policy
packages/i18n/src/plural.spec.ts      45 → 80 tests; tripwire retargeted
apps/web/src/test/browser.ts          renderPage gains `locale`, driving lang and dir
apps/web/src/test/visual.spec.tsx     5 Arabic RTL surfaces + a rendered-text assertion
apps/web/src/test/__screenshots__/    10 new Arabic baselines
docs/reports/phase-7.4c-arabic-pluralization-completion.md   NEW
docs/README.md                        index entry
```

**Unchanged:** the English catalogue, `ResourceList`, `LeafPaths`, `PluralPaths`, `MessageKey`,
`Translator`, `translate()`, `useTranslate()`, `getTranslator()`, `selectPluralForm()`, and every
item §16 places out of scope.

## 10. Remaining limitations

1. **Native review of the prose is still worth having.** The grammar was applied deliberately and is
   tested, but no Arabic speaker has read these 23 sentences. §15 classifies this honestly.
2. **`bulk.result.*` has no browser surface** — §8.
3. **`dashboard.admin.unreferenced` repeats its noun** in the label/value pair — §5.
4. **Zero forms are mostly unreachable.** `bulk.result.*` render only above zero, and several
   counters are hidden when empty. The forms exist and are asserted; they are rarely seen.

## 11. Gates

| Gate | Result | Note |
| --- | --- | --- |
| `pnpm format` | **PASS** | |
| `pnpm lint` | **PASS** | 0 errors; 7 pre-existing warnings |
| `pnpm typecheck` | **PASS** | 13/13 |
| i18n tests | **PASS** | **80** (was 45) |
| web unit tests | **PASS** | 142 |
| API tests | **PASS** | 645, 1 skipped — run, not assumed; the API shares the catalogue |
| `pnpm build` | **PASS** | 9/9 |
| `pnpm verify:styles` | **PASS** | 10/10 |
| visual + responsive | **PASS** | **94** (was 83) — 10 new Arabic baselines, every one inspected |
| **e2e `signing.e2e.spec.ts`** | **PASS** | **27 passed, 0 failed** — real API, Redis, PostgreSQL, production build, Chromium |
| e2e `recovery.e2e.spec.ts` | **FAIL** | env-gated on unset `DR_DEST_ADMIN_URL`; pre-existing since Phase 7.1B, unrelated, not skipped |
| integration | **NOT RUN** | No API, schema or contract behaviour changed; the API typechecks and its 645 tests pass |

## 12. Evidence classification

**IMPLEMENTED** — 23 Arabic plural messages, six categories each (one invariant by decision); the
policy documented in the catalogue header; `renderPage`'s locale support; five Arabic RTL surfaces.

**VERIFIED** — that every message renders the expected Arabic at 0, 1, 2, 3, 5, 10, 11, 12, 99, 100,
103 and 111; that `two` carries no digit and every other form does, across every plural key; that
`admin.grid.rowCount` and `reports.rowCount` are identical at every count; that pronouns and verbs
move with the count; that `{startedAt}` survives beside `{count}`; that no form is empty, a key, or
missing Arabic script; that Arabic RTL renders correctly at 1280 and 390 in both themes with no
overflow, clipping or bidi defect — inspected as images.

**KNOWN LIMITATION** — no browser surface for `bulk.result.*`; the repeated noun in the dashboard
figure; zero forms largely unreachable.

**NOT CLAIMED** — that the Arabic prose has been read by a native speaker. The policy was applied
carefully to attested vocabulary and every result is tested, which is a different and weaker claim
than "reviewed". A native pass remains worth doing and is not a blocker: every string is correct by
the approved rule, consistent across the product, and pinned by an assertion that will catch any
future drift.

## 13. Final status

**COMPLETE.** 23/23 completed, 0 review markers, wording tests for every message, RTL verified in a
real browser for the reachable surfaces, the bulk-result limitation documented rather than
fabricated, and every applicable gate reported with its actual result.
