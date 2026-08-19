'use client';

import type { Route } from 'next';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import {
  Badge,
  Button,
  Combobox,
  EmptyState,
  Panel,
  Select,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  useToast,
} from '@munaxa/ui';
import { KeyRound, ShieldCheck, Waypoints } from '@munaxa/icons';

import type { EffectivePermissions, ScopeChainNode, StoredAclEntry } from '@edms/contracts';
import { AclEffect, AclSubjectType, ALL_PERMISSIONS, Permission } from '@edms/domain';

import { WorkspacePage } from '../../components/workspace-page';
import { useTranslate } from '../../app/providers';
import { replaceScopeAcl, searchAclSubjects, setFolderInheritance } from './actions';

interface Named {
  readonly id: string;
  readonly name: string;
}

/**
 * Who can do what with this object, and **why** — `16-frontend-architecture.md` §2's
 * `documents/[documentId]/permissions/`, "effective and explicit ACL".
 *
 * ## This screen is a mitigation, not a convenience
 *
 * ADR-0005 accepted deny-precedence over most-specific-wins on the grounds that it is *auditable by
 * inspection*, and then wrote down the price: "a `DENY` is a blunt instrument and administrators
 * must be told so: the UI shows, for any user and object, the **effective** permission and the
 * **node that decided it**." `Decision.decidedAt` has carried that field since Phase 0.5 with
 * nothing reading it. This is its reader, and it is why the effective table's last column is the
 * node rather than a tick.
 *
 * The inverse risk is the one this screen exists for even more than the first. An over-broad
 * `ALLOW` is loud — people see things they should not, and say so. A `DENY` that inherits further
 * than intended, or an inheritance break that hides a subtree from the administrators accountable
 * for it, is silent: the screen simply shows less, and nobody reports what they never saw. So the
 * chain is rendered whether or not anything is broken, and a break is called out on it.
 *
 * ## Two tables, deliberately not one
 *
 * **Explicit** is what this node says — the editable set, and the only thing the `PUT` replaces.
 * **Effective** is what one person actually holds here, resolved over the whole chain by the
 * server. Merging them into a single editable matrix is the obvious design and it is wrong: an
 * administrator would delete a row believing it was the grant, when the grant is four levels above
 * and this node merely failed to override it.
 *
 * ## Nothing here decides a permission
 *
 * 08 §7's UI row: "the server computes this and the UI renders from it; the client never decides a
 * permission." Every outcome below came out of `GET .../permissions/effective`; none is computed
 * from the explicit entries beside it. `canManage` is likewise the server's answer to
 * `document:permission:manage`, not a guess from a role name — which is the defect this phase is
 * meant to be removing rather than adding.
 *
 * RTL: logical properties throughout (`text-start`, `ms-`), and the matrix is an ordinary column
 * layout so it mirrors whole rather than transposing — 16 §8's rule, and a permissions matrix is
 * the easiest thing in the product to get wrong in Arabic.
 */
export function PermissionsScreen({
  scopeType,
  scopeId,
  documentTitle,
  explicit,
  chain,
  inheritanceBroken,
  effective,
  subjectUserId,
  people,
  roles,
  departments,
  canManage,
  folderId,
  folderInherits,
}: {
  readonly scopeType: string;
  readonly scopeId: string;
  readonly documentTitle: string;
  readonly explicit: readonly StoredAclEntry[];
  /**
   * The chain this node sits on — a fact about the *node*, so it arrives with the explicit entries
   * rather than with the effective answer. Whether a folder above has stopped inheriting is the one
   * thing an administrator opens this screen to check, and it must not require naming somebody
   * first.
   */
  readonly chain: readonly ScopeChainNode[];
  readonly inheritanceBroken: boolean;
  /** Null until somebody is chosen: "effective for whom" has no default worth guessing. */
  readonly effective: EffectivePermissions | null;
  readonly subjectUserId: string | null;
  readonly people: readonly Named[];
  readonly roles: readonly Named[];
  readonly departments: readonly Named[];
  /** The server's answer to `document:permission:manage` on this node. */
  readonly canManage: boolean;
  /** The folder this document sits in — where inheritance is broken, if it is anywhere. */
  readonly folderId: string | null;
  readonly folderInherits: boolean;
}): ReactNode {
  const translate = useTranslate();
  const toast = useToast();
  const router = useRouter();

  const [entries, setEntries] = useState<readonly StoredAclEntry[]>(explicit);
  const [working, setWorking] = useState(false);
  const [subjectType, setSubjectType] = useState<string>(AclSubjectType.ROLE);
  const [subjectId, setSubjectId] = useState<string>('');
  const [permission, setPermission] = useState<string>(Permission.DOCUMENT_VIEW);
  const [effect, setEffect] = useState<string>(AclEffect.ALLOW);
  /** Whom the effective table is being resolved for, before the form is submitted. */
  const [resolveFor, setResolveFor] = useState<string>(subjectUserId ?? '');

  const poolFor = (type: string): readonly Named[] =>
    type === AclSubjectType.USER
      ? people
      : type === AclSubjectType.DEPARTMENT
        ? departments
        : roles;

  /**
   * What to call the subject of an entry — Slice 12.
   *
   * The server's answer first, and it is the only one that is always available: `subjectName` comes
   * back on the entry, resolved for the subjects already written on this node. The pools behind it
   * are the *pickers*, which a caller may legitimately be unable to fill — so reading a name out of
   * them was the reason this screen needed three administrative catalogues, and the reason it was
   * the route error boundary for the document controller.
   *
   * The pool lookup survives as the second step for one case only: an entry added in this session,
   * before `router.refresh()` brings back the server's copy. The identifier is the last resort, and
   * it is the honest one — an entry can name a subject that has been deleted, or never existed.
   */
  const nameOf = (entry: StoredAclEntry): string =>
    entry.subjectName ??
    poolFor(entry.subjectType).find((candidate) => candidate.id === entry.subjectId)?.name ??
    entry.subjectId;

  const save = async (next: readonly StoredAclEntry[]): Promise<void> => {
    setWorking(true);
    const result = await replaceScopeAcl(scopeType, scopeId, {
      entries: next.map((entry) => ({
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        permission: entry.permission,
        effect: entry.effect,
      })),
    });
    setWorking(false);
    if (result.ok) {
      setEntries(next);
      toast.success(translate('permissions.saved'));
      // The effective table is the server's answer and this edit changed it. Refreshing rather
      // than recomputing is the whole of "the client never decides a permission".
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  const add = async (): Promise<void> => {
    if (subjectId === '') {
      return;
    }
    // The same rule the API enforces, said before the round trip rather than instead of it: one
    // subject holds at most one effect per permission on a node.
    const clash = entries.some(
      (entry) =>
        entry.subjectType === subjectType &&
        entry.subjectId === subjectId &&
        entry.permission === permission,
    );
    if (clash) {
      toast.error(translate('permissions.duplicate'));
      return;
    }
    await save([
      ...entries,
      {
        id: `${subjectType}:${subjectId}:${permission}`,
        scopeType,
        scopeId,
        subjectType,
        subjectId,
        permission,
        effect,
        createdAt: new Date().toISOString(),
        createdBy: null,
      } as StoredAclEntry,
    ]);
  };

  const toggleInheritance = async (): Promise<void> => {
    if (folderId === null) {
      return;
    }
    setWorking(true);
    const result = await setFolderInheritance(folderId, { inheritAcl: !folderInherits });
    setWorking(false);
    if (result.ok) {
      toast.success(translate('permissions.inheritanceSaved'));
      router.refresh();
      return;
    }
    toast.error(result.detail ?? translate(`error.${result.code}`));
  };

  return (
    /*
      `WorkspacePage`, not a hand-written header — Phase 7.3.

      This screen is reached from the record page's overflow menu and it opened with an `<h1>` at
      `text-lg`: **eighteen pixels, where every other page in the product titles itself at
      twenty-four through `PageHeader`.** A page title rendered smaller than the section headings
      beneath it on the *same* screen is the clearest form of the "no visual language" defect Phase
      7.2 named, and it also meant there was no way back to the document except the browser's own
      button. Both come free from the composition every other workspace screen already uses.
    */
    <WorkspacePage
      title={translate('permissions.title')}
      description={translate('permissions.subtitle', { name: documentTitle })}
      breadcrumb={[
        { label: translate('documents.title'), href: '/documents' },
        { label: documentTitle, href: `/documents/${scopeId}` as Route },
      ]}
    >
      {/*
        The chain, always — not only when something is broken. An administrator investigating "why
        can this person not see it" has to know what the walk crossed before they can know what to
        edit, and a chain that appears only on failure is one nobody learns to read.
      */}
      <Panel
        title={
          <span className="flex items-center gap-2">
            <Waypoints className="size-4 opacity-70" aria-hidden />
            {translate('permissions.chain')}
          </span>
        }
      >
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          {chain.map((node) => (
            <li key={`${node.type}:${node.id}`} className="flex items-center gap-2">
              <Badge tone={node.breaksInheritance ? 'warning' : 'default'}>{node.name}</Badge>
              {node.breaksInheritance ? (
                <span className="text-xs">{translate('permissions.breaksHere')}</span>
              ) : null}
            </li>
          ))}
        </ol>
        {effective === null ? (
          <p className="mt-2 text-sm">{translate('permissions.chainHint')}</p>
        ) : null}
        {inheritanceBroken ? (
          <p className="mt-2 text-sm">{translate('permissions.inheritanceWarning')}</p>
        ) : null}
        {canManage && folderId !== null ? (
          <div className="mt-3">
            <Button
              type="button"
              variant="outline"
              disabled={working}
              onClick={() => {
                void toggleInheritance();
              }}
            >
              {translate(
                folderInherits ? 'permissions.breakInheritance' : 'permissions.restoreInheritance',
              )}
            </Button>
          </div>
        ) : null}
      </Panel>

      <Panel
        title={
          <span className="flex items-center gap-2">
            <KeyRound className="size-4 opacity-70" aria-hidden />
            {translate('permissions.explicit')}
          </span>
        }
      >
        <p className="text-sm">{translate('permissions.explicitHint')}</p>
        {entries.length === 0 ? (
          <EmptyState title={translate('permissions.noEntries')} />
        ) : (
          <Table className="mt-3">
            <THead>
              <TR>
                <TH>{translate('permissions.subject')}</TH>
                <TH>{translate('permissions.permission')}</TH>
                <TH>{translate('permissions.effect')}</TH>
                {canManage ? <TH>{translate('permissions.actions')}</TH> : null}
              </TR>
            </THead>
            <TBody>
              {entries.map((entry) => (
                <TR key={entry.id}>
                  <TD>{nameOf(entry)}</TD>
                  <TD>{entry.permission}</TD>
                  <TD>
                    <Badge tone={entry.effect === AclEffect.DENY ? 'danger' : 'success'}>
                      {translate(
                        entry.effect === AclEffect.DENY ? 'permissions.deny' : 'permissions.allow',
                      )}
                    </Badge>
                  </TD>
                  {canManage ? (
                    <TD>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={working}
                        onClick={() => {
                          void save(entries.filter((candidate) => candidate.id !== entry.id));
                        }}
                      >
                        {translate('permissions.revoke')}
                      </Button>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </TBody>
          </Table>
        )}

        {canManage ? (
          /*
            Four sized controls in one wrapping row, not four full-bleed dropdowns — Phase 7.3.

            `Select` inherits `fieldBase`, which is `w-full`, so inside a `flex-wrap` row with no
            width each control claimed the whole line: choosing a role and a permission meant four
            stacked 1180px dropdowns. The widths are the convention this codebase already uses for a
            toolbar select — `w-40` in `resource-list`, `w-44` in the numbering screen — with more
            room for the two identifier pickers than for the two closed vocabularies beside them.
            Read out of `fieldBase`, not guessed from the rendering.
          */
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Select
              className="w-40"
              aria-label={translate('permissions.subjectType')}
              value={subjectType}
              onChange={(event) => {
                setSubjectType(event.currentTarget.value);
                setSubjectId('');
              }}
            >
              <option value={AclSubjectType.ROLE}>{translate('permissions.role')}</option>
              <option value={AclSubjectType.USER}>{translate('permissions.user')}</option>
              <option value={AclSubjectType.DEPARTMENT}>
                {translate('permissions.department')}
              </option>
            </Select>
            <SubjectPicker
              className="w-56"
              label={translate('permissions.subject')}
              subjectType={subjectType}
              initial={poolFor(subjectType)}
              value={subjectId}
              onChange={setSubjectId}
            />
            <Select
              className="w-56"
              aria-label={translate('permissions.permission')}
              value={permission}
              onChange={(event) => {
                setPermission(event.currentTarget.value);
              }}
            >
              {/*
                From the catalogue in `@edms/domain`, which is the only place a permission exists.
                A list assembled from anything else would be the UI inventing one, which 08 §2
                forbids by name.
              */}
              {ALL_PERMISSIONS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </Select>
            <Select
              className="w-32"
              aria-label={translate('permissions.effect')}
              value={effect}
              onChange={(event) => {
                setEffect(event.currentTarget.value);
              }}
            >
              <option value={AclEffect.ALLOW}>{translate('permissions.allow')}</option>
              <option value={AclEffect.DENY}>{translate('permissions.deny')}</option>
            </Select>
            <Button
              type="button"
              disabled={working || subjectId === ''}
              onClick={() => {
                void add();
              }}
            >
              {translate('permissions.grant')}
            </Button>
          </div>
        ) : null}
      </Panel>

      <Panel
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4 opacity-70" aria-hidden />
            {translate('permissions.effective')}
          </span>
        }
      >
        <p className="text-sm">{translate('permissions.effectiveHint')}</p>
        <form className="mt-3 flex flex-wrap items-end gap-2" method="get">
          {/*
            Searchable for the same reason the subject picker is — Slice 13. This one had the
            defect in its sharper form: an administrator investigating why somebody can reach a
            document could not name that person at all if they sorted past position 100, on the
            screen ADR-0005 requires precisely so the question can be answered.

            The value reaches the URL through a hidden input rather than the control's own `name`,
            because `Combobox` renders a button and a listbox rather than a form field. The form
            stays a plain `method="get"`, so the answer is still a link somebody can send.
          */}
          <SubjectPicker
            className="w-56"
            label={translate('permissions.forPerson')}
            subjectType={AclSubjectType.USER}
            initial={people}
            value={resolveFor}
            onChange={setResolveFor}
          />
          <input type="hidden" name="userId" value={resolveFor} />
          <Button type="submit" variant="outline">
            {translate('permissions.resolve')}
          </Button>
        </form>

        {effective === null ? (
          <EmptyState title={translate('permissions.pickPerson')} />
        ) : (
          <Table className="mt-3">
            <THead>
              <TR>
                <TH>{translate('permissions.permission')}</TH>
                <TH>{translate('permissions.outcome')}</TH>
                {/* ADR-0005's mitigation, as a column. */}
                <TH>{translate('permissions.decidedBy')}</TH>
              </TR>
            </THead>
            <TBody>
              {effective.permissions.map((row) => (
                <TR key={row.permission}>
                  <TD>{row.permission}</TD>
                  <TD>
                    <Badge tone={row.allowed ? 'success' : 'muted'}>
                      {translate(row.allowed ? 'permissions.allowed' : 'permissions.refused')}
                    </Badge>
                  </TD>
                  <TD>
                    {row.decidedAtName ?? translate('permissions.noNode')}
                    <span className="ms-2 text-xs">{translate(reasonKey(row.reason))}</span>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Panel>
    </WorkspacePage>
  );
}

/** The four reasons the resolver can give, each with its own sentence in both catalogues. */
function reasonKey(reason: string): 'permissions.reason.ALLOW' {
  return `permissions.reason.${reason}` as 'permissions.reason.ALLOW';
}

/**
 * One subject, chosen out of however many the tenant has — Slice 13.
 *
 * ## The defect
 *
 * This was a `<select>` filled from one page of a hundred options, fetched with the page. A tenant
 * with more than a hundred people has people it could not offer: they sort after position 100 by
 * display name, and a native `<select>` has no way to ask for more. Proven against 150 seeded
 * people — the 150th is absent from the initial list and returned the moment it is searched for.
 *
 * ## Why a `Combobox` rather than a search box beside the select
 *
 * Because it is the pattern this codebase already uses for exactly this: `PickerField` reaches for
 * the same component and says why — *"a long list that has to be searched — a department out of
 * hundreds"*. Passing `onSearch` switches its local filtering **off** (`shouldFilter: !onSearch`)
 * and hands the query over, which is the difference between filtering a hundred rows in the browser
 * and asking the server about all of them. The debounce, the APG `combobox`/`listbox` semantics,
 * `aria-activedescendant`, the busy state and the clear control all come with it.
 *
 * ## Why the selected option is pinned
 *
 * `Combobox` renders the trigger from `options.find((o) => o.value === value)`, so an option that
 * falls out of the current result set takes its own label with it — you would choose *Amal Haddad*,
 * type something else, and watch the trigger fall back to "Choose…" while still holding her
 * identifier. The selection is never in doubt (it lives in `value`), but the *label* has to be kept
 * alive deliberately. So the chosen option is remembered and merged back in, and it survives every
 * subsequent search until something else is chosen.
 *
 * ## Why a stale response cannot land
 *
 * Each search increments a sequence number, and a reply carrying anything but the latest is
 * dropped. Typing "am" then "amal" issues two requests, and the network is under no obligation to
 * answer them in order — without this, the slower "am" could arrive last and repopulate the list
 * with the wrong thing under the right query.
 */
function SubjectPicker({
  className,
  label,
  subjectType,
  initial,
  value,
  onChange,
}: {
  readonly className: string;
  readonly label: string;
  readonly subjectType: string;
  /** The first page the server already fetched — so the picker opens populated, not empty. */
  readonly initial: readonly Named[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const translate = useTranslate();
  const [matches, setMatches] = useState<readonly Named[]>(initial);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<Named | null>(null);
  const sequence = useRef(0);
  /** Whether anybody has actually used the search box — see `search` for why it matters. */
  const touched = useRef(false);

  // Changing the kind changes the catalogue entirely, so the previous kind's matches must go with
  // it rather than linger under a heading that no longer describes them.
  useEffect(() => {
    setMatches(initial);
    setChosen(null);
    touched.current = false;
    sequence.current += 1;
  }, [subjectType, initial]);

  /*
   * The debounce inside `Combobox` means a search can still be in flight when this unmounts —
   * navigating away mid-type, or switching subject kinds. Bumping the sequence on the way out
   * makes every outstanding reply stale, which is the same mechanism that discards an out-of-order
   * one and means there is only one rule to reason about rather than two.
   */
  useEffect(() => {
    return () => {
      sequence.current += 1;
    };
  }, []);

  const search = (term: string): void => {
    /*
     * `Combobox` runs its debounce on mount as well as on input, so it announces an empty query
     * once per picker as soon as the screen renders. That first announcement is not a search: the
     * page already fetched this exact list on the server and handed it over as `initial`, and
     * honouring it would mean two round trips per page load to arrive back where we started.
     *
     * Only the *first* empty term is ignored. Clearing the box after searching is a real request
     * again — it means "show me the beginning of the list", which is a different thing from never
     * having typed.
     */
    if (term.trim() === '' && !touched.current) {
      touched.current = true;
      return;
    }
    touched.current = true;

    const ticket = (sequence.current += 1);
    setLoading(true);
    void searchAclSubjects(subjectType, term).then((result) => {
      if (ticket !== sequence.current) {
        return;
      }
      setLoading(false);
      // A refused or failed search leaves the list as it was. It is a *narrowing* of something the
      // caller can already see, so the honest degradation is "no new matches", not an empty picker
      // that reads as "this tenant has nobody".
      if (result.ok) {
        setMatches(result.value);
      }
    });
  };

  /*
   * The chosen option, kept alive across searches, plus a last resort.
   *
   * The last resort is for a value that arrived from *outside* this component — the effective-for
   * picker is re-rendered from `?userId=` after the form navigates, and if that person sorts past
   * the first page they are in neither `matches` nor `chosen`. `Combobox` would then render its
   * placeholder, so a screen with an answer on it below would say "Choose…" above. Showing the
   * identifier instead is Slice 12's convention applied to the same problem: an unnameable subject
   * falls back to what it is, never to a blank that reads as "nothing is selected".
   */
  const pinned =
    chosen !== null && !matches.some((match) => match.id === chosen.id)
      ? [chosen]
      : value !== '' && !matches.some((match) => match.id === value) && chosen === null
        ? [{ id: value, name: value }]
        : [];

  const options = [...pinned, ...matches].map((option) => ({
    value: option.id,
    label: option.name,
  }));

  return (
    <Combobox
      className={className}
      aria-label={label}
      options={options}
      value={value}
      loading={loading}
      clearable
      onSearch={search}
      onChange={(next) => {
        const picked = options.find((option) => option.value === next);
        setChosen(picked === undefined ? null : { id: picked.value, name: picked.label });
        onChange(next);
      }}
      labels={{
        placeholder: translate('permissions.choose'),
        searchPlaceholder: translate('admin.list.search'),
        empty: translate('admin.list.emptySearch'),
        loading: translate('admin.list.loading'),
        clear: translate('admin.actions.cancel'),
      }}
    />
  );
}
