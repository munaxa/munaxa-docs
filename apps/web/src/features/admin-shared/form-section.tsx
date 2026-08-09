'use client';

import type { ReactNode } from 'react';

import { Separator } from '@munaxa/ui';

/**
 * A named group of related fields inside a form — Phase 7.1.
 *
 * The forms in this product are flat: `FormDialog` renders its children in one `gap-4` column, so
 * the document upload dialogue arrives as a dropzone, a file list, two alerts, four pickers, a
 * description and however many type-specific metadata fields — eleven or more controls in one
 * undifferentiated run, with nothing saying which belong together. That is the pattern the brief's
 * §3 names, and the answer it asks for is sections rather than nested cards.
 *
 * ## Why not a card
 *
 * A card draws a boundary, and a boundary should mean something. Wrapping each group of fields in
 * its own bordered box inside a dialogue that is already a bordered box produces the
 * card-inside-a-card the brief explicitly rejects, and it costs padding on exactly the screens with
 * the least room. A heading, a sentence and a rule communicate the same grouping with none of that
 * — and they degrade to a plain readable stack when the viewport is narrow.
 *
 * ## Accessibility
 *
 * `<fieldset>` and `<legend>`, not a `<div>` and an `<h3>`. A screen reader announces the legend
 * when focus enters any control inside the group, so somebody arriving at the third picker by
 * keyboard hears "Classification, Confidentiality" rather than "Confidentiality" alone. That is the
 * whole reason the element exists, and it is free.
 *
 * The `Separator` is decorative and the platform marks it so; the legend is what carries the
 * grouping to assistive technology.
 */
export function FormSection({
  title,
  description,
  first,
  children,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  /** The first section in a form has no rule above it — a rule under nothing is a stray line. */
  readonly first?: boolean | undefined;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <>
      {first === true ? null : <Separator className="my-1" />}
      {/* `min-w-0` because a fieldset's default `min-width: min-content` is one of the two ways a
          form stops being able to shrink — the other is an unbreakable string, which Phase 7.1 met
          on the record page. */}
      <fieldset className="flex min-w-0 flex-col gap-4">
        <legend className="flex flex-col gap-1">
          <span className="text-sm font-medium">{title}</span>
          {description === undefined ? null : (
            <span className="text-muted-foreground text-xs">{description}</span>
          )}
        </legend>
        {children}
      </fieldset>
    </>
  );
}
