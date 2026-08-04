/**
 * When extracted text counts as "usable" — the decision that routes a revision to OCR.
 *
 * 14 §6: OCR runs *only* when text extraction yields nothing usable. The heuristic is
 * deliberately crude and deliberately low: forty characters is less than one sentence, so a
 * real text layer always clears it, while a scanned PDF (no layer at all) and a scan wrapped
 * in a PDF that carries only a page number stamp do not. Erring low matters because OCR output
 * on a document that has real text would *replace nothing and still cost the slow lane* — the
 * expensive engine should run only where the cheap parse found nothing to say.
 */
export const USABLE_TEXT_THRESHOLD_CHARS = 40;

export function isUsableText(totalCharacters: number): boolean {
  return totalCharacters >= USABLE_TEXT_THRESHOLD_CHARS;
}
