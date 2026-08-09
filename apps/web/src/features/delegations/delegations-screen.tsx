'use client';

import type { Route } from 'next';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useState } from 'react';

import { Badge, Button, Card, EmptyState, Select, useToast } from '@munaxa/ui';

import type { Delegation, DelegationDirection } from '@edms/contracts';
import type { MessageKey } from '@edms/i18n';
import { DelegationKind, DelegationStatus, Permission } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import { WorkspacePage } from '../../components/workspace-page';
import {
  CheckboxGroupField,
  FormDialog,
  PickerField,
  TextAreaField,
  TextField,
  list,
  optionalText,
  text,
} from '../admin-shared';
import {
  approveDelegation,
  declareEmergencyDelegation,
  declineDelegation,
  requestDelegation,
  revokeDelegation,
} from './actions';

/**
 * Delegations — `16-frontend-architecture.md` §2's `inbox/` route tree named "approval tasks,
 * delegations", and this is the half that did not exist.
 *
 * A route of its own beside `/approvals` rather than a tab inside it, because the two answer
 * different questions. `/approvals` is "what needs my decision today", worked down until it is
 * empty; this is "who is covering for whom, and until when" — an arrangement somebody sets up once
 * and reviews occasionally. Folding the second into the first would put a rarely-used form on the
 * screen an approver lives in.
 *
 * Three lists on one screen, because they are three questions with one vocabulary:
 *
 * **Given.** What I have handed to somebody else, and the only list I may revoke from.
 *
 * **Received.** What I have been handed. Nothing to approve here — a delegate agreeing to their
 * own cover is the control not existing — and it is shown because a delegate needs to know what
 * they are answerable for, and until when.
 *
 * **Awaiting my approval.** Requests from the people I manage. It is not a filter over the other
 * two and could not be: a request awaiting me names me as neither party.
 *
 * The decisions this screen deliberately does *not* offer: there is no way to name somebody else
 * as the delegator (a delegation is always your own to give away, which is what the `own` scope
 * means), and no way to extend one. A delegation that needs a new end date is a new delegation, so
 * that the period somebody agreed to is the period that ran.
 */
export function DelegationsScreen({
  delegations,
  direction,
  people,
  permissions,
}: {
  readonly delegations: readonly Delegation[];
  readonly direction: DelegationDirection;
  /** Everybody this person could delegate to, for the picker. */
  readonly people: readonly { readonly id: string; readonly name: string }[];
  /** What the caller holds, and therefore all they are able to pass on. */
  readonly permissions: readonly string[];
}): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const toast = useToast();

  const [requesting, setRequesting] = useState(false);
  const [emergency, setEmergency] = useState(false);
  const [ending, setEnding] = useState<{ id: string; kind: 'revoke' | 'decline' } | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const go = (next: DelegationDirection): void => {
    const search = new URLSearchParams(params.toString());
    search.set('direction', next);
    // The tab is in the URL, like every list in this product: a filtered view is a link somebody
    // can send, and the server component re-runs the query from it.
    router.push(`${pathname}?${search.toString()}` as Route);
  };

  const approve = async (id: string): Promise<void> => {
    setWorking(id);
    const result = await approveDelegation(id);
    setWorking(null);
    if (result.ok) {
      toast.success(translate('delegations.approved'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  return (
    <WorkspacePage
      title={translate('delegations.title')}
      description={translate('delegations.subtitle')}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Select
          aria-label={translate('delegations.filter.direction')}
          value={direction}
          onChange={(event) => {
            go(event.currentTarget.value as DelegationDirection);
          }}
        >
          <option value="GIVEN">{translate('delegations.direction.given')}</option>
          <option value="RECEIVED">{translate('delegations.direction.received')}</option>
          {/*
            Always offered, never gated on a guess. Whether this person manages anybody is the
            API's answer — the queue is filtered by the same relationship that authorises the
            approval — and hiding the tab from a manager because the client could not tell would
            be worse than showing an empty one to somebody who is not.
          */}
          <option value="AWAITING_MY_APPROVAL">
            {translate('delegations.direction.awaiting')}
          </option>
        </Select>

        <div className="ms-auto flex gap-2">
          <Button
            type="button"
            onClick={() => {
              setRequesting(true);
            }}
          >
            {translate('delegations.request')}
          </Button>
          {/*
            A separate button for a separate act. It sits beside the ordinary one rather than
            inside its dialogue, because what it skips is a control — and a control you can skip
            by ticking a box on the form that asks for it is not one somebody notices skipping.
          */}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setEmergency(true);
            }}
          >
            {translate('delegations.declareEmergency')}
          </Button>
        </div>
      </div>

      {delegations.length === 0 ? (
        <EmptyState
          title={translate(emptyKeyFor(direction))}
          description={translate('delegations.emptyHint')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {delegations.map((delegation) => (
            <li key={delegation.id}>
              <Card className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {translate('delegations.pair', {
                      delegator: delegation.delegatorName ?? delegation.delegatorId,
                      delegate: delegation.delegateName ?? delegation.delegateId,
                    })}
                  </span>
                  <Badge tone={toneFor(delegation.status)}>
                    {translate(`delegations.status.${delegation.status}`)}
                  </Badge>
                  {delegation.kind === DelegationKind.EMERGENCY && (
                    <Badge tone="warning">{translate('delegations.emergency')}</Badge>
                  )}
                  {/*
                    A re-delegation says so. "Acting under Alice's delegation to Bob" is a
                    materially different arrangement from "Bob's own", and a reader who cannot tell
                    them apart cannot review either.
                  */}
                  {delegation.depth > 0 && (
                    <Badge tone="muted">{translate('delegations.chained')}</Badge>
                  )}

                  {direction === 'AWAITING_MY_APPROVAL' && (
                    <>
                      <Button
                        type="button"
                        disabled={working !== null}
                        onClick={() => {
                          void approve(delegation.id);
                        }}
                      >
                        {translate('delegations.approve')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          setEnding({ id: delegation.id, kind: 'decline' });
                        }}
                      >
                        {translate('delegations.decline')}
                      </Button>
                    </>
                  )}
                  {direction === 'GIVEN' && isLive(delegation.status) && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setEnding({ id: delegation.id, kind: 'revoke' });
                      }}
                    >
                      {translate('delegations.revoke')}
                    </Button>
                  )}
                </div>

                <dl className="text-muted-foreground grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt>{translate('delegations.period')}</dt>
                    <dd>
                      <time dateTime={delegation.startsAt}>
                        {new Date(delegation.startsAt).toLocaleDateString()}
                      </time>
                      {' – '}
                      <time dateTime={delegation.endsAt}>
                        {new Date(delegation.endsAt).toLocaleDateString()}
                      </time>
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt>{translate('delegations.permissions')}</dt>
                    <dd className="truncate">{delegation.permissions.join(', ')}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt>{translate('delegations.used')}</dt>
                    {/*
                      §4's visibility rule as a number: "the delegator sees every action taken on
                      their behalf". The count is here and the decisions themselves are one query
                      away, rather than every list loading every decision under every delegation.
                    */}
                    <dd>{translate('delegations.useCount', { count: delegation.useCount })}</dd>
                  </div>
                  {delegation.approvedByName !== null && (
                    <div className="flex gap-2">
                      <dt>{translate('delegations.approvedBy')}</dt>
                      <dd>{delegation.approvedByName}</dd>
                    </div>
                  )}
                  {delegation.reason !== null && (
                    <div className="flex gap-2 sm:col-span-2">
                      <dt>{translate('delegations.reason')}</dt>
                      <dd className="truncate">{delegation.reason}</dd>
                    </div>
                  )}
                  {delegation.revokeReason !== null && (
                    <div className="flex gap-2 sm:col-span-2">
                      <dt>{translate('delegations.revokeReason')}</dt>
                      <dd className="truncate">{delegation.revokeReason}</dd>
                    </div>
                  )}
                  {delegation.declineReason !== null && (
                    <div className="flex gap-2 sm:col-span-2">
                      <dt>{translate('delegations.declineReason')}</dt>
                      <dd className="truncate">{delegation.declineReason}</dd>
                    </div>
                  )}
                </dl>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <FormDialog
        open={requesting}
        title={translate('delegations.request')}
        description={translate('delegations.requestHint')}
        onClose={() => {
          setRequesting(false);
        }}
        onSubmit={(data) =>
          requestDelegation({
            delegateId: text(data, 'delegateId'),
            // Datetime-local posts without a zone; the API stores instants, so it is read as the
            // browser's own time — which is the time the person typing it meant.
            startsAt: new Date(text(data, 'startsAt')).toISOString(),
            endsAt: new Date(text(data, 'endsAt')).toISOString(),
            permissions: list(data, 'permissions'),
            reason: optionalText(data, 'reason'),
          })
        }
        onSaved={() => {
          setRequesting(false);
          toast.success(translate('delegations.requested'));
          router.refresh();
        }}
      >
        <PickerField
          name="delegateId"
          label={translate('delegations.delegate')}
          hint={translate('delegations.delegateHint')}
          required
          options={people.map((person) => ({ value: person.id, label: person.name }))}
        />
        <TextField
          name="startsAt"
          type="datetime-local"
          label={translate('delegations.startsAt')}
          required
        />
        <TextField
          name="endsAt"
          type="datetime-local"
          label={translate('delegations.endsAt')}
          hint={translate('delegations.endsAtHint')}
          required
        />
        {/*
          Only what the caller holds. The API refuses the rest anyway — and again at decision
          time, which is the check that counts — but offering a permission somebody cannot pass on
          would be offering an arrangement that was never going to work.
        */}
        <CheckboxGroupField
          name="permissions"
          label={translate('delegations.permissions')}
          hint={translate('delegations.permissionsHint')}
          choices={delegablePermissions(permissions).map((permission) => ({
            value: permission,
            label: permission,
          }))}
        />
        <TextAreaField
          name="reason"
          label={translate('delegations.reason')}
          hint={translate('delegations.reasonHint')}
          maxLength={500}
        />
      </FormDialog>

      <FormDialog
        open={emergency}
        title={translate('delegations.declareEmergency')}
        description={translate('delegations.emergencyHint')}
        onClose={() => {
          setEmergency(false);
        }}
        onSubmit={(data) =>
          declareEmergencyDelegation({
            delegateId: text(data, 'delegateId'),
            endsAt: new Date(text(data, 'endsAt')).toISOString(),
            permissions: list(data, 'permissions'),
            reason: text(data, 'reason'),
          })
        }
        onSaved={() => {
          setEmergency(false);
          toast.success(translate('delegations.declared'));
          router.refresh();
        }}
      >
        <PickerField
          name="delegateId"
          label={translate('delegations.delegate')}
          required
          options={people.map((person) => ({ value: person.id, label: person.name }))}
        />
        {/* No start date: an emergency delegation begins now, or it is a request. */}
        <TextField
          name="endsAt"
          type="datetime-local"
          label={translate('delegations.endsAt')}
          hint={translate('delegations.emergencyEndsAtHint')}
          required
        />
        <CheckboxGroupField
          name="permissions"
          label={translate('delegations.permissions')}
          choices={delegablePermissions(permissions).map((permission) => ({
            value: permission,
            label: permission,
          }))}
        />
        {/*
          Required, and the field says why. This sentence is what the audit trail keeps in its own
          attested column — it is the record of a control being bypassed, not a note.
        */}
        <TextAreaField
          name="reason"
          label={translate('delegations.reason')}
          hint={translate('delegations.emergencyReasonHint')}
          required
          maxLength={500}
        />
      </FormDialog>

      <FormDialog
        open={ending !== null}
        title={translate(ending?.kind === 'decline' ? 'delegations.decline' : 'delegations.revoke')}
        description={translate(
          ending?.kind === 'decline' ? 'delegations.declineHint' : 'delegations.revokeHint',
        )}
        onClose={() => {
          setEnding(null);
        }}
        onSubmit={(data) => {
          const reason = { reason: text(data, 'reason') };
          return ending?.kind === 'decline'
            ? declineDelegation(ending.id, reason)
            : revokeDelegation(ending?.id ?? '', reason);
        }}
        onSaved={() => {
          const declined = ending?.kind === 'decline';
          setEnding(null);
          toast.success(translate(declined ? 'delegations.declined' : 'delegations.revoked'));
          router.refresh();
        }}
      >
        <TextAreaField
          name="reason"
          label={translate('delegations.reason')}
          hint={translate('delegations.endReasonHint')}
          required
          maxLength={500}
        />
      </FormDialog>
    </WorkspacePage>
  );
}

/**
 * What a person may pass on: everything they hold, minus the one thing that would compound.
 *
 * `delegation:manage` is excluded deliberately. Passing it on would let a delegate arrange further
 * cover in the delegator's name, which is a chain the tenant may not have enabled and is not what
 * anybody means by "cover my approvals while I am away". The API's chain rules would catch the
 * consequences; not offering it is how somebody avoids meeting them.
 */
function delegablePermissions(held: readonly string[]): readonly string[] {
  return held.filter((permission) => permission !== Permission.DELEGATION_MANAGE);
}

function isLive(status: Delegation['status']): boolean {
  return status === DelegationStatus.ACTIVE || status === DelegationStatus.PENDING_APPROVAL;
}

function toneFor(status: Delegation['status']): 'success' | 'warning' | 'danger' | 'muted' {
  switch (status) {
    case DelegationStatus.ACTIVE:
      return 'success';
    case DelegationStatus.PENDING_APPROVAL:
      return 'warning';
    case DelegationStatus.DECLINED:
    case DelegationStatus.REVOKED:
      return 'danger';
    default:
      return 'muted';
  }
}

/**
 * The empty-state key, as a literal rather than a template.
 *
 * `MessageKey` is a union of the catalogue's own keys, so a key assembled with a template string
 * types as `string` and would compile whether or not the message exists. Returning literals is
 * what makes a missing translation a build error, which is the whole point of typing the
 * catalogues against each other.
 */
function emptyKeyFor(direction: DelegationDirection): MessageKey {
  switch (direction) {
    case 'GIVEN':
      return 'delegations.empty.given';
    case 'RECEIVED':
      return 'delegations.empty.received';
    default:
      return 'delegations.empty.awaiting';
  }
}
