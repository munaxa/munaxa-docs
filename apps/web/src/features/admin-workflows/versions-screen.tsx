'use client';

import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Alert, Badge, Button, Dialog, Page, PageHeader, Panel, useToast } from '@munaxa/ui';

import type { WorkflowDefinition, WorkflowDefinitionBody, WorkflowVersion } from '@edms/contracts';
import { WorkflowVersionState } from '@edms/domain';

import { useSession, useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';
import type { Choice } from '../admin-shared';
import {
  addWorkflowDraft,
  deprecateWorkflowVersion,
  publishWorkflowVersion,
  updateWorkflowDraft,
} from './actions';
import { DefinitionEditor } from './definition-editor';
import { VERSION_STATE_LABELS } from './workflows-screen';

/**
 * One workflow's versions.
 *
 * The whole screen is shaped by a single rule: **a published version is immutable**. An approval binds
 * to a version, so editing one would change the rules of a run already in flight. So a published
 * version here has no edit affordance at all — not a disabled one, not one that fails on save — and the
 * way to change a live workflow is the "new draft" button, which copies the version being viewed into a
 * fresh draft to edit and publish.
 *
 * Publishing deprecates whichever version was live, in the same transaction, so there is never a moment
 * when a document type points at a workflow with no current version. Retiring is separate and gentler:
 * new approvals stop using the version, and approvals already running are untouched.
 */
export function WorkflowVersionsScreen({
  workflow,
  documentTypes,
}: {
  workflow: WorkflowDefinition;
  documentTypes: readonly Choice[];
}): ReactNode {
  const translate = useTranslate();
  const toast = useToast();
  const router = useRouter();

  /** A draft being edited, or a new draft being composed from an existing version. */
  const [draft, setDraft] = useState<{
    readonly from: WorkflowVersion;
    readonly body: WorkflowDefinitionBody;
    readonly fresh: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (action: () => Promise<ActionResult<unknown>>, onDone?: () => void): void => {
    setBusy(true);
    void action().then((result) => {
      setBusy(false);
      if (result.ok) {
        onDone?.();
        router.refresh();
        return;
      }
      toast.error(result.detail ?? translate(`error.${result.code}`));
    });
  };

  // Newest first: the version somebody came here to act on is almost always the latest one.
  const versions = [...workflow.versions].sort((left, right) => right.version - left.version);

  return (
    <Page gap={6}>
      <PageHeader
        title={workflow.name}
        description={workflow.description ?? translate('admin.workflows.description')}
        above={
          <span className="text-muted-foreground text-sm">
            {workflow.key}
            {workflow.isActive ? null : (
              <>
                {' · '}
                <Badge tone="warning">{translate('admin.list.inactiveBadge')}</Badge>
              </>
            )}
          </span>
        }
      />

      <Alert tone="info">{translate('admin.workflows.publishHint')}</Alert>

      {versions.map((version) => (
        <Panel
          key={version.id}
          title={
            <span className="flex items-center gap-2">
              {translate('admin.workflows.versionNumber', { number: version.version })}
              <Badge tone={toneFor(version)}>
                {translate(VERSION_STATE_LABELS[version.state])}
              </Badge>
            </span>
          }
          actions={
            <span className="flex flex-wrap items-center gap-2">
              {version.state === WorkflowVersionState.DRAFT ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setDraft({ from: version, body: version.definition, fresh: false });
                    }}
                  >
                    {translate('admin.actions.edit')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      run(() => publishWorkflowVersion(workflow.id, version.id, workflow.version));
                    }}
                  >
                    {translate('admin.workflows.publish')}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setDraft({ from: version, body: version.definition, fresh: true });
                  }}
                >
                  {translate('admin.workflows.newDraftFrom', { number: version.version })}
                </Button>
              )}
              {version.state === WorkflowVersionState.DEPRECATED ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    run(() => deprecateWorkflowVersion(workflow.id, version.id, workflow.version));
                  }}
                >
                  {translate('admin.workflows.deprecate')}
                </Button>
              )}
            </span>
          }
        >
          <VersionSummary version={version} />
        </Panel>
      ))}

      {draft === null ? null : (
        <Dialog
          open
          onClose={() => {
            if (!busy) {
              setDraft(null);
            }
          }}
          title={
            draft.fresh
              ? translate('admin.workflows.newDraftFrom', { number: draft.from.version })
              : translate('admin.workflows.versionNumber', { number: draft.from.version })
          }
          description={
            draft.fresh
              ? translate('admin.workflows.publishedImmutable')
              : translate('admin.workflows.publishHint')
          }
          footer={
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                }}
              >
                {translate('admin.actions.cancel')}
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={() => {
                  run(
                    () =>
                      draft.fresh
                        ? addWorkflowDraft(workflow.id, draft.body)
                        : updateWorkflowDraft(workflow.id, draft.from.id, {
                            definition: draft.body,
                          }),
                    () => {
                      setDraft(null);
                    },
                  );
                }}
              >
                {busy ? translate('admin.actions.saving') : translate('admin.actions.save')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <DefinitionEditor
              value={draft.body}
              documentTypes={documentTypes}
              disabled={busy}
              onChange={(body) => {
                setDraft({ ...draft, body });
              }}
            />
          </div>
        </Dialog>
      )}
    </Page>
  );
}

/** A version at a glance: what it applies to, its stages in order, and what it does at the end. */
function VersionSummary({ version }: { version: WorkflowVersion }): ReactNode {
  const translate = useTranslate();
  const { locale } = useSession();

  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">{translate('admin.workflows.appliesTo')}</dt>
        <dd>
          {version.definition.appliesTo.documentTypes.length === 0
            ? translate('admin.workflows.appliesToAll')
            : version.definition.appliesTo.documentTypes.join(', ')}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{translate('admin.workflows.stages')}</dt>
        <dd>
          {version.definition.stages
            .map((stage, index) => `${String(index + 1)}. ${stage.name}`)
            .join(' → ')}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{translate('admin.workflows.onComplete')}</dt>
        <dd>
          {translate(
            version.definition.onComplete.assignNumber
              ? 'admin.workflows.assignNumber'
              : 'admin.fields.no',
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{translate('admin.fields.createdAt')}</dt>
        <dd>
          {/*
            The date only, in UTC, and in the session's locale rather than the machine's — for the same
            reason the grids do it: this markup is server-rendered and then hydrated, and anything that
            reads the *machine's* locale or zone renders differently on the two sides.
          */}
          {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(
            new Date(version.createdAt),
          )}
        </dd>
      </div>
    </dl>
  );
}

function toneFor(version: WorkflowVersion): 'success' | 'warning' | 'muted' {
  if (version.state === WorkflowVersionState.PUBLISHED) {
    return 'success';
  }
  return version.state === WorkflowVersionState.DRAFT ? 'warning' : 'muted';
}
