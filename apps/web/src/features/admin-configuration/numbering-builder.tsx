'use client';

import { type ReactNode, useEffect, useId, useState } from 'react';

import { Badge, Button, Checkbox, Field, Input, Select } from '@munaxa/ui';

import type { NumberSegment, NumberingRule } from '@edms/contracts';
import { NumberSegmentKind, type NumberSegmentKindKey } from '@edms/domain';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import { previewNumberingRule } from './actions';

/** The separator, taken from the contract rather than restated: one definition of what is allowed. */
export type Separator = NumberingRule['separator'];

export const SEGMENT_LABELS: Readonly<Record<NumberSegmentKindKey, MessageKey>> = {
  LITERAL: 'admin.numbering.segmentLITERAL',
  COMPANY_CODE: 'admin.numbering.segmentCOMPANY_CODE',
  ENTITY_CODE: 'admin.numbering.segmentENTITY_CODE',
  BRANCH_CODE: 'admin.numbering.segmentBRANCH_CODE',
  DEPARTMENT_CODE: 'admin.numbering.segmentDEPARTMENT_CODE',
  DOCUMENT_TYPE_CODE: 'admin.numbering.segmentDOCUMENT_TYPE_CODE',
  CATEGORY_CODE: 'admin.numbering.segmentCATEGORY_CODE',
  YEAR: 'admin.numbering.segmentYEAR',
  MONTH: 'admin.numbering.segmentMONTH',
  SEQUENCE: 'admin.numbering.segmentSEQUENCE',
};

/** Segment kinds that resolve a code from the document's context, and so can be dropped when empty. */
const OPTIONAL_CAPABLE: readonly NumberSegmentKindKey[] = [
  NumberSegmentKind.COMPANY_CODE,
  NumberSegmentKind.ENTITY_CODE,
  NumberSegmentKind.BRANCH_CODE,
  NumberSegmentKind.DEPARTMENT_CODE,
  NumberSegmentKind.DOCUMENT_TYPE_CODE,
  NumberSegmentKind.CATEGORY_CODE,
];

/**
 * The number builder: an ordered list of segments, a separator, and a live sample.
 *
 * The sample is drawn from the API rather than rendered here, and that is the whole reason it is
 * trustworthy. The formatter is a pure function in the domain — the same one that will issue real
 * numbers — so a preview computed in the browser would be a second implementation, and the first time
 * the two disagreed would be the first time a tenant's numbers came out differently from the example
 * they approved.
 *
 * Order is the array's order. There is no index field on a segment to disagree with its position.
 */
export function NumberingBuilder({
  segments,
  separator,
  onSegmentsChange,
  onSeparatorChange,
}: {
  segments: readonly NumberSegment[];
  separator: Separator;
  onSegmentsChange: (segments: readonly NumberSegment[]) => void;
  onSeparatorChange: (separator: Separator) => void;
}): ReactNode {
  const translate = useTranslate();
  const separatorId = useId();
  const [sample, setSample] = useState<string | null>(null);
  const [omitted, setOmitted] = useState<readonly NumberSegmentKindKey[]>([]);

  useEffect(() => {
    if (segments.length === 0) {
      setSample(null);
      setOmitted([]);
      return;
    }
    // Debounced, and cancelled by the flag rather than by aborting the request: these are cheap and
    // pure, and a late answer overwriting a newer one is the only failure worth preventing.
    let current = true;
    const timer = setTimeout(() => {
      void previewNumberingRule({ separator, segments, context: {} }).then((result) => {
        if (!current) {
          return;
        }
        if (result.ok) {
          setSample(result.value.sample);
          setOmitted(result.value.omittedSegments);
        } else {
          // An invalid rule has no sample, and saying so is more useful than showing the last valid
          // one — which would look like the rule being edited.
          setSample(null);
          setOmitted([]);
        }
      });
    }, 300);

    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [segments, separator]);

  const replace = (index: number, next: NumberSegment): void => {
    onSegmentsChange(segments.map((segment, position) => (position === index ? next : segment)));
  };

  const swap = (index: number, with_: number): void => {
    if (with_ < 0 || with_ >= segments.length) {
      return;
    }
    const next = [...segments];
    const moved = next[index];
    const other = next[with_];
    if (moved === undefined || other === undefined) {
      return;
    }
    next[index] = other;
    next[with_] = moved;
    onSegmentsChange(next);
  };

  return (
    <>
      <Field label={translate('admin.numbering.separator')} htmlFor={separatorId}>
        <Select
          id={separatorId}
          value={separator}
          onChange={(event) => {
            onSeparatorChange(event.currentTarget.value as Separator);
          }}
        >
          {(['-', '/', '.', '_'] as const).map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
          <option value="">{translate('admin.numbering.separatorNone')}</option>
        </Select>
      </Field>

      <Field label={translate('admin.numbering.segments')}>
        <div className="flex flex-col gap-2">
          {segments.map((segment, index) => (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <Select
                aria-label={translate('admin.numbering.segments')}
                value={segment.kind}
                className="min-w-44 flex-1"
                onChange={(event) => {
                  replace(index, blankSegment(event.currentTarget.value as NumberSegmentKindKey));
                }}
              >
                {Object.values(NumberSegmentKind).map((kind) => (
                  <option key={kind} value={kind}>
                    {translate(SEGMENT_LABELS[kind])}
                  </option>
                ))}
              </Select>

              {segment.kind === NumberSegmentKind.LITERAL ? (
                <Input
                  aria-label={translate('admin.numbering.literalValue')}
                  value={segment.value}
                  maxLength={16}
                  className="w-28"
                  onChange={(event) => {
                    replace(index, {
                      kind: NumberSegmentKind.LITERAL,
                      value: event.currentTarget.value,
                    });
                  }}
                />
              ) : null}

              {segment.kind === NumberSegmentKind.YEAR ? (
                <Select
                  aria-label={translate('admin.numbering.yearDigits')}
                  value={String(segment.digits)}
                  className="w-24"
                  onChange={(event) => {
                    replace(index, {
                      kind: NumberSegmentKind.YEAR,
                      digits: event.currentTarget.value === '2' ? 2 : 4,
                    });
                  }}
                >
                  <option value="2">2</option>
                  <option value="4">4</option>
                </Select>
              ) : null}

              {segment.kind === NumberSegmentKind.SEQUENCE ? (
                <Input
                  type="number"
                  aria-label={translate('admin.numbering.padding')}
                  value={String(segment.padding)}
                  min={1}
                  max={12}
                  className="w-20"
                  onChange={(event) => {
                    replace(index, {
                      kind: NumberSegmentKind.SEQUENCE,
                      padding: Number.parseInt(event.currentTarget.value, 10) || 1,
                    });
                  }}
                />
              ) : null}

              {OPTIONAL_CAPABLE.includes(segment.kind) && 'optional' in segment ? (
                <Checkbox
                  checked={segment.optional}
                  label={translate('admin.numbering.omitted')}
                  onChange={(event) => {
                    replace(index, {
                      kind: segment.kind,
                      optional: event.currentTarget.checked,
                    });
                  }}
                />
              ) : null}

              <div className="ms-auto flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={translate('admin.actions.move')}
                  disabled={index === 0}
                  onClick={() => {
                    swap(index, index - 1);
                  }}
                >
                  <span aria-hidden>↑</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={translate('admin.actions.move')}
                  disabled={index === segments.length - 1}
                  onClick={() => {
                    swap(index, index + 1);
                  }}
                >
                  <span aria-hidden>↓</span>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={translate('admin.actions.delete')}
                  onClick={() => {
                    onSegmentsChange(segments.filter((_, position) => position !== index));
                  }}
                >
                  <span aria-hidden>✕</span>
                </Button>
              </div>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={segments.length >= 12}
            onClick={() => {
              onSegmentsChange([...segments, blankSegment(NumberSegmentKind.LITERAL)]);
            }}
          >
            {translate('admin.numbering.addSegment')}
          </Button>
        </div>
      </Field>

      <Field label={translate('admin.numbering.sample')}>
        <div className="flex flex-col gap-1">
          <p className="font-mono text-sm">
            {sample ?? translate('admin.numbering.samplePending')}
          </p>
          {omitted.length === 0 ? null : (
            <p className="text-muted-foreground text-xs">
              {translate('admin.numbering.omittedThisSample', {
                parts: omitted.map((kind) => translate(SEGMENT_LABELS[kind])).join(', '),
              })}
            </p>
          )}
          {sample === null && segments.length > 0 ? (
            <Badge tone="warning">{translate('error.VALIDATION_FAILED')}</Badge>
          ) : null}
        </div>
      </Field>
    </>
  );
}

/**
 * A newly chosen kind, with the contract's own defaults.
 *
 * Rebuilt rather than merged onto the previous segment: the shape is a discriminated union, so a
 * `YEAR` carrying a leftover `padding` is not a `YEAR` — and the union is what stops a segment the
 * formatter cannot resolve from ever being saved.
 */
function blankSegment(kind: NumberSegmentKindKey): NumberSegment {
  switch (kind) {
    case NumberSegmentKind.LITERAL:
      return { kind, value: '' };
    case NumberSegmentKind.YEAR:
      return { kind, digits: 4 };
    case NumberSegmentKind.MONTH:
      return { kind };
    case NumberSegmentKind.SEQUENCE:
      return { kind, padding: 4 };
    default:
      return { kind, optional: false };
  }
}
