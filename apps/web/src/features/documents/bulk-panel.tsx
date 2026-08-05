'use client';

import { type ReactNode, useState } from 'react';

import { Badge, Button, Dialog, Select, useToast } from '@munaxa/ui';

import type { BulkOperationResult } from '@edms/contracts';

import { useTranslate } from '../../app/providers';
import type { Choice } from '../admin-shared';
import { bulkExportLinks, bulkSetMetadata } from './bulk-actions';

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
  const toast = useToast();
  const [links, setLinks] = useState<
    readonly { documentId: string; filename: string; url: string }[]
  >([]);

  const notApplied = result.items.filter((item) => item.outcome !== 'APPLIED');

  const fetchLinks = (): void => {
    void bulkExportLinks(result.operationId).then((answer) => {
      if (!answer.ok) {
        toast.error(answer.detail ?? translate(`error.${answer.code}`));
        return;
      }
      setLinks(answer.value.links);
    });
  };

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

        {/* An export's deliverable. Fetched on request rather than with the result, because a
            signed link *is* a release happening and minting forty of them for a dialogue nobody
            scrolls would write forty audit rows for links nobody used. */}
        {result.kind === 'EXPORT' && result.tally.applied > 0 && (
          <div className="flex flex-col gap-2">
            {links.length === 0 ? (
              <Button type="button" variant="secondary" onClick={fetchLinks}>
                {translate('bulk.result.links')}
              </Button>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {links.map((link) => (
                  <li key={link.documentId}>
                    <a className="underline" href={link.url}>
                      {link.filename}
                    </a>
                  </li>
                ))}
              </ul>
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
