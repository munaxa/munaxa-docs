import type { ReactNode } from 'react';

import { Skeleton } from '@munaxa/ui';

import { en } from '@edms/i18n';

/**
 * The route-level loading state — Phase 7.1.
 *
 * Streaming means the shell paints first and this fills the content column, rather than the page
 * being blank until the slowest query returns. What filled it until now was a centred spinner, and
 * a spinner has two problems that a skeleton does not.
 *
 * **It is the same shape on every route**, so it says "something is happening" and nothing else. A
 * skeleton in the shape of a page header over a block of content says *what* is coming, which is
 * the difference between waiting and wondering.
 *
 * **It is the wrong size.** A 64px-tall centred spinner followed by a full page is a layout shift
 * on every navigation — the content jumps into place from a different height. These blocks
 * approximate the real thing: a title, a line of description, and a body the height of a short
 * list. Nothing here is exact and nothing needs to be; what matters is that the box does not
 * collapse to a fraction of what replaces it.
 *
 * ## Accessibility
 *
 * `Skeleton` is `aria-hidden` by the platform's own decision — a screen reader should hear the
 * loading state once, from whatever owns the request, rather than a stream of announcements from
 * every shimmering box. So the announcement lives here, on one `role="status"` region, and the
 * blocks inside it are purely visual. The pulse respects `prefers-reduced-motion` in the platform's
 * implementation; nothing in this file re-states that.
 */
export default function Loading(): ReactNode {
  return (
    <div className="flex flex-col gap-6" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{en.state.loading}</span>

      {/* The page header: a title, and the sentence under it that most screens have. */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      {/* A toolbar's worth of controls, which is what sits above every list in this product. */}
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-56 max-w-full" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-24" />
      </div>

      {/* The body. Six rows rather than one block: the shape of a list is the shape most of these
          routes resolve to, and a single tall rectangle reads as an image rather than as content. */}
      <div className="border-border flex flex-col gap-3 rounded-xl border p-4">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <Skeleton key={row} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}
