'use client';

import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, type ReactNode, useId, useState } from 'react';

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Timeline,
  TimelineItem,
  useToast,
} from '@munaxa/ui';

import type { AuditEntry, AuditExport, AuditPage } from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';

import { useTranslate } from '../../app/providers';
import { downloadAuditExport, requestAuditExport } from './actions';

/**
 * The audit search — `13-audit-architecture.md` §6's "filterable by actor, action, target, date,
 * correlation id", and the evidence exports beside it.
 *
 * The URL is the whole of the query, exactly as it is for the document list and for search: a
 * filtered trail is a link somebody sends to a colleague, and a compliance question asked twice
 * should be asked with the same address. The results come from the server component that renders
 * this; the only things this component *does* are change the URL and request an export.
 *
 * There is deliberately no free-text box. The trail is structured, and a search over `payload`
 * would be both a promise the index cannot keep and an invitation to store more in a payload than
 * 13 §3 permits.
 */
export function AuditScreen({
  page,
  actions,
  exports,
  canExport,
}: {
  readonly page: AuditPage | null;
  readonly actions: readonly string[];
  readonly exports: readonly AuditExport[];
  readonly canExport: boolean;
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();
  const [exporting, setExporting] = useState(false);

  const value = (key: string): string => params.get(key) ?? '';

  const apply = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = new URLSearchParams();
    for (const key of ['action', 'actorId', 'outcome', 'correlationId', 'from', 'to'] as const) {
      const entry = form.get(key);
      if (typeof entry === 'string' && entry.trim() !== '') {
        next.set(key, entry.trim());
      }
    }
    router.push(`${pathname}?${next.toString()}` as Route);
  };

  const startExport = async (): Promise<void> => {
    setExporting(true);
    // The same range and filters the screen is showing. An export that quietly covered something
    // else would be an evidence bundle that does not answer the question it was asked for.
    const result = await requestAuditExport({
      from: value('from') === '' ? defaultFrom() : new Date(value('from')).toISOString(),
      to: value('to') === '' ? new Date().toISOString() : new Date(value('to')).toISOString(),
      ...(value('action') === '' ? {} : { action: value('action') }),
      ...(value('actorId') === '' ? {} : { actorId: value('actorId') }),
      ...(value('outcome') === '' ? {} : { outcome: value('outcome') }),
    });
    setExporting(false);
    if (result.ok) {
      toast.success(translate('audit.export.requested'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate('audit.export.failed'));
  };

  const takeBundle = async (id: string): Promise<void> => {
    const result = await downloadAuditExport(id);
    if (!result.ok) {
      toast.error(result.detail ?? translate('audit.export.failed'));
      return;
    }
    // One tab per artefact. The bundle is a prefix rather than an archive — see the export
    // service for why — so "download the bundle" is three signed links, and each is audited.
    for (const link of result.value.data) {
      window.open(link.url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <>
      <PageHeader title={translate('audit.title')} description={translate('audit.subtitle')} />

      <Card className="p-4">
        {/*
          The filters stay a plain form read through `FormData` on submit, rather than the
          platform's `SearchBuilder`. The trail is queried by a fixed, server-known set of
          columns — actor, action, outcome, correlation, range — and the URL is the whole of the
          query so a filtered trail is a link somebody sends a colleague. A condition builder
          would offer field/operator/value combinations the endpoint does not accept.
        */}
        <form onSubmit={apply} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FilterField label={translate('audit.filter.action')}>
              {(id) => (
                <Select id={id} name="action" defaultValue={value('action')}>
                  <option value="">{translate('audit.filter.anyAction')}</option>
                  {actions.map((action) => (
                    <option key={action} value={action}>
                      {action}
                    </option>
                  ))}
                </Select>
              )}
            </FilterField>

            <FilterField label={translate('audit.filter.outcome')}>
              {(id) => (
                <Select id={id} name="outcome" defaultValue={value('outcome')}>
                  <option value="">{translate('audit.filter.anyOutcome')}</option>
                  <option value="SUCCESS">{translate('audit.outcome.success')}</option>
                  <option value="DENIED">{translate('audit.outcome.denied')}</option>
                  <option value="FAILED">{translate('audit.outcome.failed')}</option>
                </Select>
              )}
            </FilterField>

            <FilterField label={translate('audit.filter.actor')}>
              {(id) => <Input id={id} name="actorId" defaultValue={value('actorId')} />}
            </FilterField>

            <FilterField label={translate('audit.filter.correlation')}>
              {(id) => <Input id={id} name="correlationId" defaultValue={value('correlationId')} />}
            </FilterField>

            {/*
              Native `type="date"` rather than the platform's `DatePicker`: these two feed a
              `FormData` read on submit, and the picker is a controlled component whose value
              lives in React state. Swapping it in means lifting both dates into state and
              changing how the form is read — a behaviour change on the screen that answers an
              auditor, for no gain the native control does not already give. Recorded as a
              deliberate keep in the Phase 5.1 migration matrix.
            */}
            <FilterField label={translate('audit.filter.from')}>
              {(id) => (
                <Input id={id} type="date" name="from" defaultValue={value('from').slice(0, 10)} />
              )}
            </FilterField>

            <FilterField label={translate('audit.filter.to')}>
              {(id) => (
                <Input id={id} type="date" name="to" defaultValue={value('to').slice(0, 10)} />
              )}
            </FilterField>
          </div>

          <div>
            <Button type="submit">{translate('audit.filter.apply')}</Button>
          </div>
        </form>
      </Card>

      {page === null ? (
        <Card className="p-4">
          <EmptyState
            title={translate('audit.promptTitle')}
            description={translate('audit.promptHint')}
          />
        </Card>
      ) : (
        <Card className="flex flex-col gap-3 p-4">
          <p className="text-muted-foreground text-sm">
            {translate('audit.resultsCount', {
              count: page.data.length,
              total: page.meta.total,
            })}
          </p>
          {page.data.length === 0 ? (
            <EmptyState title={translate('audit.empty')} />
          ) : (
            <Timeline>
              {page.data.map((entry) => (
                <ClientAuditRow key={entry.id} entry={entry} />
              ))}
            </Timeline>
          )}
        </Card>
      )}

      {canExport && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium">{translate('audit.export.title')}</h2>
            <p className="text-muted-foreground text-sm">{translate('audit.export.hint')}</p>
          </div>

          <div>
            <Button
              type="button"
              disabled={exporting}
              onClick={() => {
                void startExport();
              }}
            >
              {translate(exporting ? 'audit.export.requesting' : 'audit.export.request')}
            </Button>
          </div>

          {exports.length === 0 ? (
            <EmptyState title={translate('audit.export.none')} />
          ) : (
            <ul className="flex flex-col gap-2">
              {exports.map((bundle) => (
                <li key={bundle.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground font-mono">
                    {new Date(bundle.requestedAt).toISOString().slice(0, 19).replace('T', ' ')}
                  </span>
                  <Badge tone={toneFor(bundle.state)}>{translate(stateKey(bundle.state))}</Badge>
                  {bundle.state === 'COMPLETED' && (
                    <>
                      <span>{translate('audit.export.events', { count: bundle.eventCount })}</span>
                      {bundle.chainIntact === false && (
                        <Badge tone="danger">{translate('audit.export.chainBroken')}</Badge>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          void takeBundle(bundle.id);
                        }}
                      >
                        {translate('audit.export.download')}
                      </Button>
                    </>
                  )}
                  {bundle.error !== null && (
                    <em className="text-muted-foreground">— {bundle.error}</em>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}

/**
 * A filter control with its label associated by id.
 *
 * The `id` is generated rather than derived from the field name because `useId` is what keeps two
 * instances of a form on one page from sharing a label target. It is handed to the child so the
 * control and the `Field` cannot disagree about it.
 */
function FilterField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: (id: string) => ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      {children(id)}
    </Field>
  );
}

/** The row, for the client screen. The timeline's server component renders the same facts. */
function ClientAuditRow({ entry }: { readonly entry: AuditEntry }): ReactNode {
  const translate = useTranslate();
  return (
    <TimelineItem
      timestamp={new Date(entry.occurredAt).toISOString().replace('T', ' ').slice(0, 19)}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <strong className="font-mono">{entry.action}</strong>
          <Badge tone="muted">{entry.subjectType}</Badge>
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

/** A year, when the screen has no range of its own. Long enough to be useful, short enough to end. */
function defaultFrom(): string {
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  return from.toISOString();
}

function toneFor(state: AuditExport['state']): 'muted' | 'warning' | 'danger' {
  if (state === 'FAILED') {
    return 'danger';
  }
  return state === 'COMPLETED' ? 'muted' : 'warning';
}

/**
 * The catalogue key for an export's state.
 *
 * Spelled out rather than built from the value. A dotted key assembled at runtime is a key the
 * type system cannot check and the build cannot catch when it is renamed — which is the whole
 * reason `MessageKey` is a typed leaf path.
 */
function stateKey(state: AuditExport['state']): MessageKey {
  switch (state) {
    case 'REQUESTED':
      return 'audit.export.state.requested';
    case 'RUNNING':
      return 'audit.export.state.running';
    case 'COMPLETED':
      return 'audit.export.state.completed';
    case 'FAILED':
      return 'audit.export.state.failed';
  }
}
