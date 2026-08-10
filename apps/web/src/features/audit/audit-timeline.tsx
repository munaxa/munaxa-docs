import type { ReactNode } from 'react';

import { Badge, EmptyState, Panel, Stack, Timeline, TimelineItem } from '@munaxa/ui';
import { History } from '@munaxa/icons';

import type { AuditEntry, AuditPage } from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { adminGet } from '../../lib/admin/api';
import { getTranslator } from '../../lib/server-i18n';

/**
 * The document timeline — `16-frontend-architecture.md` §2's `documents/[id]/audit`, rendered on
 * the record page rather than as a screen of its own.
 *
 * ## Why it is a server component that fetches inside itself
 *
 * §7's row for record pages is "shell first, preview and audit stream in", and that only works if
 * the audit fetch is *not* in the page's own `Promise.all`. A component that awaits its own data
 * suspends on its own, so the shell — the number, the title, the actions — paints while the trail
 * is still being read, and a slow audit query delays nothing a person is waiting for. Putting the
 * fetch in the page would make the whole record page as slow as its slowest panel, which is the
 * shape §7 exists to avoid.
 *
 * ## Why a refusal renders nothing rather than an error
 *
 * The API answers a timeline the caller may not see with `404`, deliberately — the existence of a
 * trail is itself an answer. So the panel treats every failure the same way: it is absent. That is
 * the same posture the preview panel takes, and it is the only one consistent with an API that
 * refuses by pretending not to exist.
 */
export async function AuditTimeline({
  subjectType,
  subjectId,
  limit = 20,
}: {
  readonly subjectType: 'DOCUMENT' | 'REVISION' | 'FOLDER' | 'LIBRARY';
  readonly subjectId: string;
  readonly limit?: number;
}): Promise<ReactNode> {
  const translate = await getTranslator();
  const page = await adminGet<AuditPage>(
    `/audit/timeline/${subjectType}/${subjectId}?page=1&pageSize=${String(limit)}`,
  ).catch(() => null);

  if (page === null) {
    return null;
  }

  return (
    /*
      The section title, its landmark and its rule all come from `Panel` — Phase 7.2.

      This used to be a `Card` with a hand-written `<h2 className="text-sm font-medium">`, and four
      other panels on the same page each had their own. Five sections, five type treatments, and not
      one of them a labelled region a screen-reader user could jump to. `Panel` answers all of that
      with one prop: it renders the heading in the display face at one size, draws the rule that
      separates a section's title from its contents, and exposes the whole thing as a labelled
      `region`.
    */
    <Panel
      title={
        <span className="flex items-center gap-2">
          <History className="size-4 opacity-70" aria-hidden />
          {translate('audit.timelineTitle')}
        </span>
      }
    >
      <Stack gap={3}>
        <p className="text-muted-foreground text-sm">{translate('audit.timelineHint')}</p>

        {page.data.length === 0 ? (
          <EmptyState title={translate('audit.empty')} />
        ) : (
          <Timeline>
            {page.data.map((entry) => (
              <AuditRow key={entry.id} entry={entry} translate={translate} />
            ))}
          </Timeline>
        )}

        {page.meta.hasMore && (
          <p className="text-muted-foreground text-sm">
            {translate('audit.showingRecent', {
              count: page.data.length,
              total: page.meta.total,
            })}
          </p>
        )}
      </Stack>
    </Panel>
  );
}

export type Translate = (
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>,
) => string;

/**
 * One event.
 *
 * **The action code is rendered verbatim, not translated.** `DOCUMENT_APPROVED` is the audit
 * catalogue's own vocabulary (13 §2): it is what an auditor filters by, what an evidence export
 * contains, and what a compliance report groups on. Translating it would give the same event two
 * names — one on a screen and one in the bundle — and make a person's screenshot unmatchable to
 * the row it came from.
 *
 * **The digest is shown with its version.** The version is what says how much the digest proves: a
 * row written before the widening attests nine fields, one written since attests every column but
 * the hashes. Rendering both identically would tell a reader the older half of their trail is
 * verified to a standard it is not.
 */
export function AuditRow({
  entry,
  translate,
}: {
  readonly entry: AuditEntry;
  readonly translate: Translate;
}): ReactNode {
  return (
    <TimelineItem
      timestamp={new Date(entry.occurredAt).toISOString().replace('T', ' ').slice(0, 19)}
      title={
        <span className="flex flex-wrap items-center gap-2">
          {/* `font-mono` because the action code is an identifier an auditor matches against an
              export, and a proportional face makes two similar codes harder to tell apart. */}
          <strong className="font-mono">{entry.action}</strong>
          {entry.outcome !== 'SUCCESS' && (
            <Badge tone={entry.outcome === 'DENIED' ? 'warning' : 'danger'}>
              {translate(
                entry.outcome === 'DENIED' ? 'audit.outcome.denied' : 'audit.outcome.failed',
              )}
            </Badge>
          )}
          {entry.reason !== null && <em className="text-muted-foreground">— {entry.reason}</em>}
        </span>
      }
      meta={
        <>
          {translate('audit.sequence', { sequence: entry.sequence })} ·{' '}
          {translate('audit.digest', {
            digest: entry.hash.slice(0, 12),
            version: entry.chainHashVersion,
          })}
        </>
      }
    />
  );
}
