'use client';

import type { ReactNode } from 'react';

import { Badge } from '@munaxa/ui';
import {
  Archive,
  CalendarOff,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleX,
  Clock,
  type Icon,
  Layers,
  Lock,
  PencilLine,
  Send,
  Trash2,
  TriangleAlert,
} from '@munaxa/icons';

import { DocumentStatus, type DocumentStatusKey } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';

/**
 * A document's lifecycle state, said the same way everywhere — Phase 7.
 *
 * `06-document-lifecycle.md` defines thirteen states and the product rendered all of them
 * identically: the library's status column was `<Badge>{label}</Badge>`, search used
 * `tone="muted"`, and the record page used the default tone. So `PUBLISHED`, `REJECTED` and
 * `EXPIRED` were the same shade of the same badge, and a reader scanning two hundred rows had to
 * read every one of them to find the four that mattered.
 *
 * ## Colour is never the only signal
 *
 * Each state carries an icon as well as its tone, and the label is always present. That is not
 * decoration: the platform offers five tones for thirteen states, so tone alone cannot be
 * distinguishing even for a reader who sees colour perfectly — `ARCHIVED` and `SUPERSEDED` are both
 * muted, and the archive box and the layers mark are what tell them apart. It also happens to be
 * what makes the badge legible to the eight percent of men with a colour vision deficiency.
 *
 * The icon is `aria-hidden`: the badge already says the word, and a screen reader announcing
 * "archive, Archived" would say it twice.
 *
 * ## Why the mapping lives here rather than in the domain package
 *
 * A tone is a presentation decision — which of five visual weights this product gives a state — and
 * `@edms/domain` is shared with the API and the worker, neither of which has a palette. The
 * *states* come from the domain enum, and the exhaustive record below means a state added there is
 * a type error here rather than a badge that silently falls back.
 */
const PRESENTATION: Readonly<
  Record<DocumentStatusKey, { readonly tone: BadgeTone; readonly icon: Icon }>
> = {
  // Nobody has been asked for anything yet. Muted, because a folder of drafts is the normal state
  // of an authoring library and colouring it would make the ordinary look urgent.
  [DocumentStatus.DRAFT]: { tone: 'muted', icon: PencilLine },
  // Somebody is now waiting on somebody else. Default rather than warning: a submission that has
  // been waiting an hour is not a problem, and `07-workflow-architecture.md` gives overdue its own
  // signal.
  [DocumentStatus.SUBMITTED]: { tone: 'default', icon: Send },
  [DocumentStatus.UNDER_REVIEW]: { tone: 'default', icon: Clock },
  // The author has to act. Warning is the right weight — the document has stopped moving and only
  // one person can restart it.
  [DocumentStatus.CHANGES_REQUESTED]: { tone: 'warning', icon: TriangleAlert },
  [DocumentStatus.REJECTED]: { tone: 'danger', icon: CircleX },
  /*
   * **`default` rather than `success`, and it is a measurement rather than a preference.**
   *
   * Green is the obviously right colour for "approved" and "published", and the platform's
   * `success` badge cannot carry it accessibly: `text-success-strong` on `bg-success/15` measures
   * **4.21:1** in the Docs light palette and **3.98:1** in dark, against the 4.5:1 WCAG 2.1 AA
   * requires for text below 18.66px — and a badge's label is 12px. Both figures were measured by
   * axe in a real browser against the built stylesheet when Phase 7 first shipped these two as
   * `success`, which is how the defect was found at all.
   *
   * This product cannot fix it. The classes are the component's own, and `ARCHITECTURE.md` forbids
   * hardcoding a colour to work around a platform palette. So the choice was between shipping a
   * known AA failure and using a tone that passes; the brief's own rule — visual polish is not
   * permission to weaken accessibility — settles it.
   *
   * The two states stay distinguishable, because the design never leaned on tone alone: the hollow
   * mark and the filled one are what separate "approved but not yet in effect" from "in effect",
   * and they are readable in greyscale. The palette fix is written up as a platform issue in the
   * Phase 7 report, and this comment is what should be deleted when it lands.
   */
  [DocumentStatus.APPROVED]: { tone: 'default', icon: CircleDot },
  [DocumentStatus.PUBLISHED]: { tone: 'default', icon: CircleCheck },
  // Somebody holds the lock. Warning because it is a state another person's work bumps into.
  [DocumentStatus.CHECKED_OUT]: { tone: 'warning', icon: Lock },
  [DocumentStatus.SUPERSEDED]: { tone: 'muted', icon: Layers },
  [DocumentStatus.ARCHIVED]: { tone: 'muted', icon: Archive },
  [DocumentStatus.EXPIRED]: { tone: 'danger', icon: CalendarOff },
  // In the recycle bin, and recoverable. Danger rather than muted: a reader who finds one of these
  // in a list has found something that is on its way out of the library.
  [DocumentStatus.DELETED]: { tone: 'danger', icon: Trash2 },
  // Destroyed. Only ever seen on a tombstone, where the row outlives the record it describes.
  [DocumentStatus.PURGED]: { tone: 'muted', icon: CircleDashed },
};

type BadgeTone = 'default' | 'success' | 'warning' | 'danger' | 'muted';

/** Exported for the test that keeps this table in step with the lifecycle enum. */
export function statusPresentation(status: DocumentStatusKey): {
  readonly tone: BadgeTone;
  readonly icon: Icon;
} {
  return PRESENTATION[status];
}

/**
 * Whether a string off the wire is a state this product knows.
 *
 * The search projection stores a document's status as plain text — it is a denormalised copy made
 * when the document was indexed, and `SearchHit.status` is typed `string` for that reason. A hit
 * written before a state was renamed is a real possibility, and the honest answer is to show the
 * word the index holds rather than to crash or to guess a tone for it.
 */
function isKnownStatus(status: string): status is DocumentStatusKey {
  return Object.hasOwn(PRESENTATION, status);
}

export function DocumentStatusBadge({
  status,
  className,
}: {
  /**
   * Plain `string`, not `DocumentStatusKey`, and deliberately so — see `isKnownStatus`.
   *
   * The search projection stores the status as denormalised text and `SearchHit.status` is typed
   * `string`. Narrowing here would push a cast onto every caller; widening keeps the one honest
   * check in this file, where the fallback lives beside it.
   */
  readonly status: string;
  readonly className?: string;
}): ReactNode {
  const translate = useTranslate();

  if (!isKnownStatus(status)) {
    return (
      <Badge tone="muted" {...(className !== undefined && { className })}>
        {status}
      </Badge>
    );
  }

  const { tone, icon: StatusIcon } = statusPresentation(status);

  return (
    /*
     * The icon and the word are **direct children** of the badge, with the gap set on the badge
     * itself rather than on a wrapper — and that is not a style preference.
     *
     * `Badge` is already `inline-flex items-center`, so a wrapping span bought nothing visually. It
     * cost something real: axe blames the innermost element that carries the text, so a wrapper
     * became the reported node and no longer carried the badge's own `text-primary-strong` class.
     * The visual suite tolerates exactly one platform contrast defect and identifies it *by that
     * class name*, so the wrapper turned a documented, inherited 4.31:1 into an unrecognised
     * violation that failed the build. Keeping the text on the badge keeps the tolerance honest:
     * the same pixels, the same known defect, still the only one allowed.
     */
    <Badge tone={tone} className={className === undefined ? 'gap-1' : `gap-1 ${className}`}>
      {/* `size-3` rather than the platform's `size-4`: this sits inside a badge whose text is
          `text-xs`, and an icon the size of the surrounding line looks pasted on. */}
      <StatusIcon className="size-3 shrink-0" aria-hidden />
      {translate(`documents.status.${status}` as MessageKey)}
    </Badge>
  );
}
