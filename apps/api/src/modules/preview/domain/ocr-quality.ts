/**
 * Below this mean word confidence (0–100, the engine's own scale), OCR output is flagged in
 * the UI as a low-confidence read rather than presented as the document's words
 * (`14-preview-architecture.md` §6). Seventy is where Tesseract's own documentation starts
 * calling a page "poor"; the flag is presentation, not suppression — the text still serves
 * search, because a poor read that finds the document beats no read that cannot.
 */
export const LOW_OCR_CONFIDENCE_THRESHOLD = 70;
