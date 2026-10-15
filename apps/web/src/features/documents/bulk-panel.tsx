'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

import { Badge, Button, Dialog, Select, useToast } from '@munaxa/ui';

import type { BulkExportItems, BulkOperationResult } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { Choice } from '../admin-shared';
import {
  bulkExportItemLink,
  bulkExportItems,
  bulkExportManifestLink,
  bulkSetMetadata,
} from './bulk-actions';

/**
 * What a bulk operation did, per object.
 *
 * **This dialogue is the reason the API returns a body instead of `204`.** A bulk operation's
 * interesting half is the part that did not happen, and there are three distinct ways for an object
 * not to have happened: the caller does not reach it, a rule refused it, or something broke. A
 * toast saying "38 of 40 succeeded" throws all three away — and the three call for entirely
 * different responses, from "you selected across a boundary you cannot see" to "a matter is on
 * hold" to "somebody should look at this".
 *
 * So the outcomes are rendered, grouped, with a sentence per group. The identifiers are shown only
 * for the ones that did not apply: a list of thirty-eight successful UUIDs is noise, and the two
 * that were refused are what somebody opened this for.
 */
export function BulkResultDialog({
  result,
  onClose,
}: {
  readonly result: BulkOperationResult;
  readonly onClose: () => void;
}): ReactNode {
  const translate = useTranslate();
  const [showReleased, setShowReleased] = useState(false);

  const notApplied = result.items.filter((item) => item.outcome !== 'APPLIED');

  return (
    <Dialog open onClose={onClose} title={translate('bulk.result.title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          {translate('bulk.result.summary', {
            applied: result.tally.applied,
            requested: result.tally.requested,
          })}
        </p>

        {/* One sentence per non-empty group, so a reader learns what to do rather than a number. */}
        {result.tally.refused > 0 && (
          <p className="text-muted-foreground text-sm">
            {translate('bulk.result.refusedHint', { count: result.tally.refused })}
          </p>
        )}
        {result.tally.blocked > 0 && (
          <p className="text-muted-foreground text-sm">
            {translate('bulk.result.blockedHint', { count: result.tally.blocked })}
          </p>
        )}
        {result.tally.failed > 0 && (
          <p className="text-destructive text-sm">
            {translate('bulk.result.failedHint', { count: result.tally.failed })}
          </p>
        )}

        {notApplied.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {notApplied.map((item) => (
              <li key={item.targetId} className="flex items-center gap-2">
                <Badge tone={item.outcome === 'FAILED' ? 'danger' : 'muted'}>
                  {translate(`bulk.outcome.${item.outcome}`)}
                </Badge>
                <code className="text-xs">{item.targetId}</code>
              </li>
            ))}
          </ul>
        )}

        {/* An export's deliverable: its released documents, listed without a single URL. A link
            is a release happening, so each is issued when its own button is clicked, re-checked
            in full, and followed by navigation — never a column of links that expire unseen. */}
        {result.kind === 'EXPORT' && result.tally.applied > 0 && (
          <div className="flex flex-col gap-2">
            {showReleased ? (
              <ReleasedDocuments operationId={result.operationId} />
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setShowReleased(true);
                }}
              >
                {translate('bulk.result.links')}
              </Button>
            )}
          </div>
        )}

        <div className="flex justify-end">
          <Button type="button" onClick={onClose}>
            {translate('bulk.result.close')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A completed export's released documents, a page at a time — ADR-0026 §10, the export design §3.1.
 *
 * What the API answers is what the person may know *now*: each document they can still see, with
 * the revision the export released beside the one a download serves, and — when it cannot be
 * downloaded — why, in words that never say more than they may know. Documents they can no longer
 * see are a count. Each Download issues its own verified link and navigates to it.
 */
function ReleasedDocuments({ operationId }: { readonly operationId: string }): ReactNode {
  const translate = useTranslate();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState<BulkExportItems | null>(null);

  // The latest toast and translate, read when an answer arrives — so the fetch depends on what it
  // asks for (the operation and the page) and nothing a re-render may hand out anew.
  const say = useRef({ toast, translate });
  say.current = { toast, translate };

  useEffect(() => {
    let current = true;
    void bulkExportItems(operationId, page).then((answer) => {
      if (!current) {
        return;
      }
      if (!answer.ok) {
        say.current.toast.error(answer.detail ?? say.current.translate(`error.${answer.code}`));
        return;
      }
      setListing(answer.value);
    });
    return () => {
      current = false;
    };
  }, [operationId, page]);

  const follow = (answer: Awaited<ReturnType<typeof bulkExportItemLink>>): void => {
    if (!answer.ok) {
      toast.error(answer.detail ?? translate(`error.${answer.code}`));
      return;
    }
    // Navigation, as a document's own download: the answer is an attachment, so the page stays.
    window.location.assign(answer.value.url);
  };

  if (listing === null) {
    return null;
  }
  const refused = listing.tally.refused + listing.tally.blocked + listing.tally.failed;
  return (
    <section aria-label={translate('bulk.result.exported.title')} className="flex flex-col gap-2">
      <p className="text-sm">
        {translate('bulk.result.exported.counts', {
          included: listing.tally.applied,
          refused,
        })}
      </p>
      {listing.hidden > 0 && (
        <p className="text-muted-foreground text-sm">
          {translate('bulk.result.exported.hidden', { count: listing.hidden })}
        </p>
      )}
      <ul className="flex flex-col gap-2 text-sm">
        {listing.data.map((item) => (
          <li key={item.documentId} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0">
              <span className="font-medium">{item.documentNumber ?? item.title}</span>
              {item.currentRevisionLabel !== null && (
                <span className="text-muted-foreground ms-2 text-xs">
                  {item.exportedRevisionLabel !== null &&
                  item.exportedRevisionLabel !== item.currentRevisionLabel
                    ? translate('bulk.result.exported.revisions', {
                        exported: item.exportedRevisionLabel,
                        current: item.currentRevisionLabel,
                      })
                    : translate('bulk.result.exported.current', {
                        current: item.currentRevisionLabel,
                      })}
                </span>
              )}
            </span>
            {item.available ? (
              <Button
                type="button"
                variant="ghost"
                aria-label={translate('bulk.result.exported.download', {
                  name: item.filename ?? item.title,
                })}
                onClick={() => {
                  void bulkExportItemLink(operationId, item.documentId).then(follow);
                }}
              >
                <span dir="auto">{item.filename ?? item.title}</span>
              </Button>
            ) : (
              <Badge tone="muted">
                {translate(
                  `bulk.result.exported.unavailable.${item.unavailableReason ?? 'NOT_PERMITTED'}`,
                )}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            disabled={page === 1}
            onClick={() => {
              setPage(page - 1);
            }}
          >
            {translate('bulk.result.exported.previous')}
          </Button>
          <span className="text-xs">{translate('bulk.result.exported.page', { page })}</span>
          <Button
            type="button"
            variant="ghost"
            disabled={!listing.meta.hasMore}
            onClick={() => {
              setPage(page + 1);
            }}
          >
            {translate('bulk.result.exported.next')}
          </Button>
        </span>
        {listing.manifestAvailable && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void bulkExportManifestLink(operationId).then(follow);
            }}
          >
            {translate('bulk.result.exported.manifest')}
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * The one bulk edit that needs a form: which category these documents take.
 *
 * **Confidentiality is deliberately absent**, and its absence is the contract rather than a
 * shortcut. Changing a document's confidentiality changes who may see it, so the single-object
 * `PATCH` demands an `If-Match` for that field alone — and a bulk request cannot carry one version
 * per document. The API refuses the field for that reason; offering it here and having every
 * document fail a version check would be the same refusal, discovered fifty times.
 */
export function BulkMetadataDialog({
  ids,
  categories,
  onDone,
  onClose,
}: {
  readonly ids: readonly string[];
  readonly categories: readonly Choice[];
  readonly onDone: (result: BulkOperationResult) => void;
  readonly onClose: () => void;
}): ReactNode {
  const translate = useTranslate();
  const toast = useToast();
  const [categoryId, setCategoryId] = useState('');
  const [working, setWorking] = useState(false);

  const submit = (): void => {
    setWorking(true);
    void bulkSetMetadata({ ids: [...ids], categoryId: categoryId === '' ? null : categoryId }).then(
      (answer) => {
        setWorking(false);
        if (!answer.ok) {
          toast.error(answer.detail ?? translate(`error.${answer.code}`));
          return;
        }
        onDone(answer.value);
      },
    );
  };

  return (
    <Dialog open onClose={onClose} title={translate('bulk.action.metadata')}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          {translate('documents.field.category')}
          <Select
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.currentTarget.value);
            }}
          >
            <option value="">—</option>
            {categories.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={working}>
            {translate('bulk.result.close')}
          </Button>
          <Button type="button" onClick={submit} disabled={working}>
            {translate('admin.actions.save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
