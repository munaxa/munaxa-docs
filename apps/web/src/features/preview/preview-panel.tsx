'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Document, PreviewContent, PreviewManifest, PreviewText } from '@edms/contracts';
import { Alert, Button, Card, Spinner, useToast } from '@munaxa/ui';

import { useTranslate } from '../../app/providers';
import {
  fetchPreviewManifest,
  fetchPreviewText,
  requestPreviewContent,
  requestPreviewPrint,
} from './actions';
import { ImageViewer } from './image-viewer';
import { PdfViewer } from './pdf-viewer';
import { TextViewer } from './text-viewer';

/**
 * The document viewer — the panel Phase 7 adds to the document screen, beside the approval and
 * revision panels and arriving the same way: a slot the screen renders without knowing what it
 * holds.
 *
 * Modular by construction: this panel owns the chrome — toolbar, polling, search, fullscreen —
 * and delegates the pixels to one of three interchangeable panes (`PdfViewer`, `ImageViewer`,
 * `TextViewer`) chosen by the manifest's `mode`. A new renderer server-side means at most one
 * new pane here, and usually none.
 *
 * What it never does is decide a permission. `canPrint`/`canDownload` are the caller's
 * permissions from the server, the manifest's `confidentiality` is the level's subtraction,
 * and both must agree before an affordance renders — the same rule as every other screen. The
 * content URL is requested per open through a server action (issuing is audited), and preview
 * itself deliberately needs no download permission.
 */
export interface PreviewPanelProps {
  readonly document: Document;
  readonly initialManifest: PreviewManifest;
  readonly canPrint: boolean;
  readonly canDownload: boolean;
}

/** How long the panel keeps asking about a PENDING render before offering a manual retry. */
const POLL_INTERVAL_MS = 3_000;
const POLL_BUDGET_MS = 120_000;

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

export function PreviewPanel({
  document,
  initialManifest,
  canPrint,
  canDownload,
}: PreviewPanelProps) {
  const translate = useTranslate();
  const toast = useToast();

  const [manifest, setManifest] = useState<PreviewManifest>(initialManifest);
  const [content, setContent] = useState<PreviewContent | null>(null);
  const [text, setText] = useState<PreviewText | null>(null);
  const [pollExpired, setPollExpired] = useState(false);

  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(initialManifest.pageCount ?? 0);
  const [zoomIndex, setZoomIndex] = useState(2);
  const [rotation, setRotation] = useState(0);
  const [query, setQuery] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);

  // While the queue works, ask again — the 202 contract's client half. Bounded, so a render
  // that dead-lettered does not leave a spinner running for the rest of the session.
  useEffect(() => {
    if (manifest.state !== 'PENDING' || pollExpired) {
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > POLL_BUDGET_MS) {
        setPollExpired(true);
        clearInterval(timer);
        return;
      }
      void fetchPreviewManifest(document.id).then((fresh) => {
        if (fresh !== null && fresh.state !== 'PENDING') {
          setManifest(fresh);
          clearInterval(timer);
        }
      });
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [manifest.state, pollExpired, document.id]);

  // The content URL, once ready — one audited issuance per viewer open, not per render.
  const openContent = useCallback(() => {
    void requestPreviewContent(document.id).then((result) => {
      if (result.ok) {
        setContent(result.value);
      } else {
        toast.error(result.detail ?? translate(`error.${result.code}`));
      }
    });
  }, [document.id, toast, translate]);

  useEffect(() => {
    if (manifest.state === 'READY' && (manifest.mode === 'PDF' || manifest.mode === 'IMAGE')) {
      openContent();
    }
  }, [manifest.state, manifest.mode, openContent]);

  // The extracted text: the TEXT pane's content, and every mode's in-document search.
  useEffect(() => {
    if (manifest.state === 'READY' && manifest.hasText) {
      void fetchPreviewText(document.id).then(setText);
    }
  }, [manifest.state, manifest.hasText, document.id]);

  useEffect(() => {
    const onChange = () => {
      setFullscreen(window.document.fullscreenElement === frameRef.current);
    };
    window.document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.document.removeEventListener('fullscreenchange', onChange);
    };
  }, []);

  const toggleFullscreen = () => {
    const frame = frameRef.current;
    if (frame === null) {
      return;
    }
    if (window.document.fullscreenElement === frame) {
      void window.document.exitFullscreen();
    } else {
      void frame.requestFullscreen();
    }
  };

  const print = () => {
    if (manifest.mode === 'TEXT') {
      // The text pane is the preview; printing it is printing the preview. The affordance is
      // still permission-gated below — it simply has no rendition to fetch.
      window.print();
      return;
    }
    void requestPreviewPrint(document.id).then((result) => {
      if (!result.ok) {
        toast.error(result.detail ?? translate(`error.${result.code}`));
        return;
      }
      if (result.value.url === null) {
        toast.error(translate('preview.printUnavailable'));
        return;
      }
      printThroughFrame(result.value.url);
    });
  };

  const matches = countMatches(text, query);
  const offerPrint =
    canPrint && manifest.confidentiality.printAllowed && manifest.state === 'READY';

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <h2 className="text-sm font-semibold">{translate('preview.title')}</h2>
        {manifest.state === 'READY' ? (
          <div className="flex flex-wrap items-center gap-1">
            {manifest.hasText ? (
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                placeholder={translate('preview.searchPlaceholder')}
                aria-label={translate('preview.searchPlaceholder')}
                className="h-8 w-40 rounded border bg-transparent px-2 text-sm"
              />
            ) : null}
            {query.trim().length > 0 ? (
              <span className="px-1 text-xs opacity-70">
                {translate('preview.matches', { count: matches.total })}
              </span>
            ) : null}
            {matches.pages.length > 0 && manifest.mode === 'PDF' ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPage(nextMatchPage(matches.pages, page));
                }}
              >
                {translate('preview.nextMatch')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setZoomIndex((index) => Math.max(0, index - 1));
              }}
              aria-label={translate('preview.zoomOut')}
            >
              −
            </Button>
            <span className="w-12 text-center text-xs tabular-nums opacity-70">
              {String(Math.round((ZOOM_STEPS[zoomIndex] ?? 1) * 100))}%
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1));
              }}
              aria-label={translate('preview.zoomIn')}
            >
              +
            </Button>
            {manifest.mode !== 'TEXT' ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRotation((value) => (value + 90) % 360);
                }}
              >
                {translate('preview.rotate')}
              </Button>
            ) : null}
            {manifest.mode === 'PDF' && pageCount > 1 ? (
              <span className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page <= 1}
                  onClick={() => {
                    setPage((value) => Math.max(1, value - 1));
                  }}
                  aria-label={translate('preview.previousPage')}
                >
                  ‹
                </Button>
                <span className="text-xs tabular-nums opacity-70">
                  {translate('preview.pageOf', { current: page, total: pageCount })}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={page >= pageCount}
                  onClick={() => {
                    setPage((value) => Math.min(pageCount, value + 1));
                  }}
                  aria-label={translate('preview.nextPage')}
                >
                  ›
                </Button>
              </span>
            ) : null}
            {offerPrint ? (
              <Button size="sm" variant="outline" onClick={print}>
                {translate('preview.print')}
              </Button>
            ) : null}
            <Button size="sm" variant="outline" onClick={toggleFullscreen}>
              {translate(fullscreen ? 'preview.exitFullscreen' : 'preview.fullscreen')}
            </Button>
          </div>
        ) : null}
      </div>

      {manifest.ocr !== null && manifest.ocr.lowConfidence ? (
        <Alert tone="warning" className="m-3">
          {translate('preview.lowConfidenceOcr', { confidence: manifest.ocr.confidence })}
        </Alert>
      ) : null}

      <div
        ref={frameRef}
        className={
          fullscreen
            ? 'flex h-full flex-col overflow-auto bg-[Canvas]'
            : 'max-h-[70vh] min-h-48 overflow-auto'
        }
      >
        <PreviewBody
          manifest={manifest}
          content={content}
          text={text}
          page={page}
          zoom={ZOOM_STEPS[zoomIndex] ?? 1}
          rotation={rotation}
          query={query}
          pollExpired={pollExpired}
          canDownload={canDownload}
          onPageCount={setPageCount}
          onRefresh={() => {
            setPollExpired(false);
            void fetchPreviewManifest(document.id).then((fresh) => {
              if (fresh !== null) {
                setManifest(fresh);
              }
            });
          }}
          onContentExpired={openContent}
        />
      </div>
    </Card>
  );
}

function PreviewBody({
  manifest,
  content,
  text,
  page,
  zoom,
  rotation,
  query,
  pollExpired,
  canDownload,
  onPageCount,
  onRefresh,
  onContentExpired,
}: {
  readonly manifest: PreviewManifest;
  readonly content: PreviewContent | null;
  readonly text: PreviewText | null;
  readonly page: number;
  readonly zoom: number;
  readonly rotation: number;
  readonly query: string;
  readonly pollExpired: boolean;
  readonly canDownload: boolean;
  readonly onPageCount: (count: number) => void;
  readonly onRefresh: () => void;
  readonly onContentExpired: () => void;
}) {
  const translate = useTranslate();

  if (manifest.state === 'PENDING') {
    return (
      <Centered>
        {pollExpired ? (
          <>
            <p className="text-sm opacity-70">{translate('preview.stillRendering')}</p>
            <Button size="sm" variant="outline" onClick={onRefresh}>
              {translate('preview.checkAgain')}
            </Button>
          </>
        ) : (
          <>
            <Spinner />
            <p className="text-sm opacity-70">{translate('preview.rendering')}</p>
          </>
        )}
      </Centered>
    );
  }

  if (manifest.state === 'UNSUPPORTED' || manifest.state === 'FAILED') {
    return (
      <Centered>
        <p className="text-sm opacity-70">
          {translate(manifest.state === 'UNSUPPORTED' ? 'preview.unsupported' : 'preview.failed')}
        </p>
        {canDownload && manifest.confidentiality.downloadAllowed ? (
          <p className="text-xs opacity-60">{translate('preview.downloadInstead')}</p>
        ) : null}
      </Centered>
    );
  }

  if (manifest.mode === 'TEXT') {
    return text === null ? (
      <Centered>
        <Spinner />
      </Centered>
    ) : (
      <TextViewer
        text={text}
        zoom={zoom}
        query={query}
        pageLabel={(value) => translate('preview.pageLabel', { page: value })}
      />
    );
  }

  if (content === null || content.url === null) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }
  if (manifest.mode === 'IMAGE') {
    return (
      <ImageViewer
        url={content.url}
        alt={translate('preview.title')}
        zoom={zoom}
        rotation={rotation}
        onError={onContentExpired}
      />
    );
  }
  return (
    <PdfViewer
      url={content.url}
      page={page}
      zoom={zoom}
      rotation={rotation}
      onPageCount={onPageCount}
      onError={onContentExpired}
    />
  );
}

function Centered({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 p-6">{children}</div>
  );
}

/** Where the needle appears, per page — how search jumps a PDF to the right page. */
function countMatches(
  text: PreviewText | null,
  query: string,
): { total: number; pages: readonly number[] } {
  const needle = query.trim().toLowerCase();
  if (text === null || needle.length === 0) {
    return { total: 0, pages: [] };
  }
  let total = 0;
  const pages: number[] = [];
  for (const entry of text.pages) {
    const haystack = entry.text.toLowerCase();
    let count = 0;
    let cursor = haystack.indexOf(needle);
    while (cursor !== -1) {
      count += 1;
      cursor = haystack.indexOf(needle, cursor + needle.length);
    }
    total += count;
    if (count > 0 && entry.page !== null) {
      pages.push(entry.page);
    }
  }
  return { total, pages };
}

function nextMatchPage(pages: readonly number[], current: number): number {
  return pages.find((value) => value > current) ?? pages[0] ?? current;
}

/**
 * Prints a fetched rendition through a hidden frame, so what reaches the paper is the
 * watermarked artefact — never the original, which the print permission does not cover.
 */
function printThroughFrame(url: string): void {
  const frame = window.document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.insetInlineEnd = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.src = url;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    // Removed later rather than on afterprint, which iframes report unreliably; a hidden,
    // zero-sized frame costs nothing meanwhile.
    setTimeout(() => {
      frame.remove();
    }, 60_000);
  };
  window.document.body.appendChild(frame);
}
