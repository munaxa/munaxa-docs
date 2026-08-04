'use client';

import { Fragment } from 'react';

import type { PreviewText } from '@edms/contracts';

/**
 * The text pane — for the formats whose extraction *is* their presentation (plain text, an
 * Office document in a deployment without a converter) and for OCR output. The browser's own
 * text layout is what makes this the honest Arabic renderer: shaping and bidi come from the
 * engine that already does them right.
 */
export interface TextViewerProps {
  readonly text: PreviewText;
  readonly zoom: number;
  /** The current search needle; occurrences are highlighted in place. */
  readonly query: string;
  readonly pageLabel: (page: number) => string;
}

export function TextViewer({ text, zoom, query, pageLabel }: TextViewerProps) {
  return (
    <div
      className="mx-auto max-w-3xl space-y-6 overflow-auto p-6"
      style={{ fontSize: `${String(zoom)}rem` }}
      dir="auto"
    >
      {text.pages.map((page, index) => (
        <section key={page.page ?? index}>
          {page.page !== null ? (
            <div className="mb-1 text-xs font-medium uppercase tracking-wide opacity-60">
              {pageLabel(page.page)}
            </div>
          ) : null}
          <pre className="whitespace-pre-wrap break-words font-sans leading-relaxed">
            {highlight(page.text, query)}
          </pre>
        </section>
      ))}
    </div>
  );
}

function highlight(text: string, query: string) {
  const needle = query.trim();
  if (needle.length === 0) {
    return text;
  }
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'));
  return parts.map((part, index) =>
    part.toLowerCase() === needle.toLowerCase() ? (
      <mark key={index}>{part}</mark>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
