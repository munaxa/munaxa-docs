import { type ZipLimits, readZipEntries, readZipEntry } from './zip';

/**
 * Text extraction from OOXML documents — the file's own words, read without a rendering engine.
 *
 * Every OOXML document is a ZIP of XML parts, and the text in each lives in one element the
 * specification fixes: `<w:t>` runs in a Word body, `<t>` in a workbook's shared strings,
 * `<a:t>` in a slide's shapes. Pulling those out is a scan for well-known tags, not a layout
 * job — which is why it needs no converter, no sandbox heavier than the archive caps, and no
 * dependency. What it cannot do, honestly, is paginate: where the page breaks fall is the
 * layout engine's answer, so a Word body extracts as one unpaginated text and only a
 * presentation — whose parts *are* its pages — extracts per slide.
 */

export interface ExtractedText {
  /** 1-based page (slide) number, or null when the format has no page boundary to honour. */
  readonly page: number | null;
  readonly text: string;
}

/** The Word body: one unpaginated text, paragraphs preserved as line breaks. */
export function extractDocxText(bytes: Buffer, limits: ZipLimits): readonly ExtractedText[] {
  const body = readZipEntry(bytes, 'word/document.xml', limits);
  if (body === null) {
    return [];
  }
  const xml = body.toString('utf8');
  // Paragraph ends become line breaks before runs are joined, so two paragraphs do not fuse
  // into one word. Tabs and explicit breaks carry the same intent.
  const withBreaks = xml
    .replace(/<w:p\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t');
  const text = collectTagText(withBreaks, 'w:t');
  return text.length === 0 ? [] : [{ page: null, text }];
}

/**
 * The workbook's text: shared strings and inline strings, one unpaginated artefact.
 *
 * Sheets are not pages — a sheet prints to as many pages as its content demands — so the
 * honest shape is one text. Cell values that are numbers live outside the string table and are
 * not text; a spreadsheet's arithmetic is not something search should pretend to have read.
 */
export function extractXlsxText(bytes: Buffer, limits: ZipLimits): readonly ExtractedText[] {
  const parts: string[] = [];
  const shared = readZipEntry(bytes, 'xl/sharedStrings.xml', limits);
  if (shared !== null) {
    const text = collectTagText(shared.toString('utf8').replace(/<\/si>/g, '\n'), 't');
    if (text.length > 0) {
      parts.push(text);
    }
  }
  for (const sheet of readZipEntries(
    bytes,
    (name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
    limits,
  )) {
    const inline = collectTagText(sheet.content.toString('utf8').replace(/<\/row>/g, '\n'), 't');
    if (inline.length > 0 && shared === null) {
      parts.push(inline);
    }
  }
  const text = parts.join('\n').trim();
  return text.length === 0 ? [] : [{ page: null, text }];
}

/** The presentation's text, per slide — the one OOXML format whose parts are its pages. */
export function extractPptxText(bytes: Buffer, limits: ZipLimits): readonly ExtractedText[] {
  const slides = readZipEntries(bytes, (name) => /^ppt\/slides\/slide\d+\.xml$/.test(name), limits)
    .map((entry) => ({
      ordinal: Number(/slide(\d+)\.xml$/.exec(entry.name)?.[1] ?? '0'),
      content: entry.content,
    }))
    .sort((a, b) => a.ordinal - b.ordinal);

  return slides
    .map((slide, index) => ({
      page: index + 1,
      text: collectTagText(slide.content.toString('utf8').replace(/<\/a:p>/g, '\n'), 'a:t'),
    }))
    .filter((slide) => slide.text.length > 0);
}

/**
 * Every occurrence of one text tag's content, entities decoded, whitespace settled.
 *
 * A tag scan rather than an XML parser, deliberately: the input has already passed the archive
 * caps, the tags are fixed by the OOXML specification, and the only thing wanted is their
 * character data. A full parser would be more code trusting the same input further.
 */
function collectTagText(xml: string, tag: string): string {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  const pieces: string[] = [];
  let match;
  let cursor = 0;
  while ((match = pattern.exec(xml)) !== null) {
    // Line breaks introduced by the callers' structural replacements, between the previous
    // match and this one, survive as breaks; everything else between tags is markup.
    const between = xml.slice(cursor, match.index);
    if (pieces.length > 0) {
      pieces.push(between.includes('\n') ? '\n' : ' ');
    }
    pieces.push(decodeEntities(match[1] ?? ''));
    cursor = pattern.lastIndex;
  }
  return pieces
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code: number): string {
  return Number.isInteger(code) && code >= 0x20 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : '';
}
