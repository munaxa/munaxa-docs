'use client';

import { useEffect, useRef, useState } from 'react';

import { Spinner } from '@munaxa/ui';

/**
 * The PDF pane — pdf.js, in the browser, where a real canvas lives.
 *
 * The server deliberately rasterises nothing: a canvas in Node is a native binding, and the
 * client already has the genuine article. What arrives is the rendition (watermark burned in
 * where the level demands), and this draws one page at a time at the requested zoom and
 * rotation — a four-hundred-page manual costs one page of pixels, not four hundred.
 */

// pdf.js is loaded lazily so the workspace bundle does not carry a PDF engine into screens
// that never open one. The worker is bundled from the same package, resolved at build time —
// no CDN, which is the constraint an air-gapped deployment actually has.
type PdfJs = typeof import('pdfjs-dist');
type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;

let pdfjsLoaded: Promise<PdfJs> | null = null;
async function loadPdfJs(): Promise<PdfJs> {
  pdfjsLoaded ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString();
    return pdfjs;
  });
  return pdfjsLoaded;
}

export interface PdfViewerProps {
  readonly url: string;
  readonly page: number;
  readonly zoom: number;
  readonly rotation: number;
  readonly onPageCount: (count: number) => void;
  readonly onError: () => void;
}

export function PdfViewer({ url, page, zoom, rotation, onPageCount, onError }: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pdf, setPdf] = useState<PdfDocument | null>(null);
  const [drawing, setDrawing] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocument | null = null;
    void loadPdfJs()
      .then((pdfjs) => pdfjs.getDocument({ url, isEvalSupported: false }).promise)
      .then((document) => {
        if (cancelled) {
          void document.destroy();
          return;
        }
        loaded = document;
        setPdf(loaded);
        onPageCount(loaded.numPages);
      })
      .catch(() => {
        if (!cancelled) {
          onError();
        }
      });
    return () => {
      cancelled = true;
      if (loaded !== null) {
        void loaded.destroy();
      }
    };
    // The URL is the document's identity here; everything else is drawing state — the second
    // effect below owns redrawing, so this deliberately depends on the URL alone.
  }, [url]);

  useEffect(() => {
    if (pdf === null) {
      return;
    }
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    setDrawing(true);
    void pdf
      .getPage(Math.min(Math.max(1, page), pdf.numPages))
      .then((pdfPage) => {
        if (cancelled) {
          return;
        }
        const canvas = canvasRef.current;
        if (canvas === null) {
          return;
        }
        const ratio = window.devicePixelRatio || 1;
        const viewport = pdfPage.getViewport({
          scale: zoom * ratio,
          rotation: (pdfPage.rotate + rotation) % 360,
        });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = `${String(viewport.width / ratio)}px`;
        canvas.style.height = `${String(viewport.height / ratio)}px`;
        const context = canvas.getContext('2d');
        if (context === null) {
          return;
        }
        const render = pdfPage.render({ canvasContext: context, viewport });
        task = render;
        return render.promise;
      })
      .then(() => {
        if (!cancelled) {
          setDrawing(false);
        }
      })
      .catch(() => {
        // A cancelled render throws by design; a failed one leaves the previous pixels, which
        // is better than blanking the page a person is reading.
        if (!cancelled) {
          setDrawing(false);
        }
      });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, page, zoom, rotation]);

  return (
    <div className="relative flex justify-center overflow-auto">
      {drawing ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </div>
      ) : null}
      <canvas ref={canvasRef} className="max-w-full shadow" />
    </div>
  );
}
