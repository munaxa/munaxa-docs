'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useTransition } from 'react';

import {
  AppShell,
  AppShellProvider,
  Badge,
  Button,
  buttonVariants,
  Input,
  NavigationDrawer,
  type RenderNavigationLink,
  Sidebar,
  SidebarCollapseToggle,
  SidebarNav,
  SidebarTrigger,
  TopBar,
  UserMenu,
  ProductLogo,
  useTheme,
} from '@munaxa/ui';

import {
  Bell,
  ChartColumn,
  FileCheck,
  FileText,
  Files,
  House,
  Moon,
  type Icon,
  ScrollText,
  Search,
  Settings,
  Sun,
  SunMoon,
  Trash2,
  UserRoundCheck,
} from '@munaxa/icons';

import { Locale, type MessageKey } from '@edms/i18n';

import { useSession, useTranslate } from '../app/providers';
import { switchLocale } from '../lib/locale';
import type { NavigationDestination } from '../lib/navigation';

/** One rendered rail row, in the shape `SidebarNav` takes. */
interface NavigationRow {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly active: boolean;
  readonly badge?: ReactNode;
}

/**
 * One icon per destination.
 *
 * Not decoration, and not a redesign. `SidebarNav` renders **only** the icon when the rail is
 * collapsed — the label becomes `sr-only` so the accessible name survives — which means a
 * destination without one is a blank row of clickable space for anybody using the narrow rail.
 * The icons are what make that state usable, which is why they arrive in a phase that may not
 * change visual identity.
 *
 * Keyed by destination id rather than declared in `lib/navigation.ts`, because that module is
 * read on the server and a React component is not something to send across that boundary.
 */
const NAVIGATION_ICONS: Readonly<Record<string, Icon>> = {
  home: House,
  documents: Files,
  approvals: FileCheck,
  search: Search,
  audit: ScrollText,
  'recycle-bin': Trash2,
  delegations: UserRoundCheck,
  notifications: Bell,
  reports: ChartColumn,
  admin: Settings,
};

/**
 * What a destination with no entry above gets.
 *
 * A fallback rather than nothing, because "nothing" is the blank collapsed row this map exists to
 * prevent — a new destination would silently reintroduce the defect. `workspace-shell.spec.tsx`
 * asserts that every destination has a *real* icon, so this is a safety net that a test stops
 * anyone from relying on.
 */
const FALLBACK_ICON: Icon = FileText;

export function iconFor(destinationId: string): Icon {
  return NAVIGATION_ICONS[destinationId] ?? FALLBACK_ICON;
}

/** Exported for the test that keeps `NAVIGATION_ICONS` in step with the destination table. */
export const NAVIGATION_ICON_IDS: readonly string[] = Object.keys(NAVIGATION_ICONS);

/**
 * The rail's sections — Phase 7.
 *
 * Ten destinations were handed to `SidebarNav` as **one group**, so Home, Documents, Approvals,
 * Search, Audit, Recycle bin, Delegations, Notifications, Reports and Administration read as one
 * undifferentiated list. A rail like that says nothing about what kind of product this is; a reader
 * looking for the audit trail scans all ten every time.
 *
 * Four sections, in the order somebody works: what is in front of you, where the records live, what
 * you oversee, and how the tenant is configured. The first has no heading — a lone dashboard link
 * under the word "Overview" is a heading longer than the thing it heads, and `NavigationGroup`
 * makes `title` optional for exactly this.
 *
 * ## Why the headings were absent for four phases
 *
 * Phase 7.1 measured `SidebarNav`'s group heading at **2.78:1** on the Docs light surface —
 * `text-muted-foreground/70`, a *fade of* the muted token, at `text-[10px]`, against the 4.5:1
 * WCAG 2.1 AA asks of text that size. There was no product-side fix: the classes are the platform
 * component's own, and both remedies available here — overriding platform styling, or hardcoding a
 * colour — are forbidden by `ARCHITECTURE.md`. So the titles were held behind a constant while the
 * arrangement shipped without them.
 *
 * `@munaxa/platform` 1.0.1 dropped the `/70`, and the bundle this product now consumes paints the
 * heading `text-muted-foreground` — the same full-strength token as the rail items beside it.
 * `consistency.e2e.spec.ts` measures it in the running application at **≥ 4.5:1 in both themes**,
 * unconditionally. The constant is gone rather than set to `true`, because a flag that can only
 * hold one value is not a flag.
 *
 * Keyed by destination id, like `NAVIGATION_ICONS` above and for the same reason: which
 * destinations exist is the server's decision, resolved from permissions in `lib/navigation.ts`;
 * how the ones that exist are arranged on screen is this file's. A group whose destinations the
 * caller does not hold is dropped rather than rendered empty — the platform's own rule.
 */
const NAVIGATION_SECTIONS: readonly {
  readonly id: string;
  readonly titleKey: MessageKey | null;
  readonly destinations: readonly string[];
}[] = [
  { id: 'overview', titleKey: null, destinations: ['home'] },
  { id: 'library', titleKey: 'nav.groupLibrary', destinations: ['documents', 'search'] },
  {
    id: 'work',
    titleKey: 'nav.groupWork',
    destinations: ['approvals', 'delegations', 'notifications'],
  },
  {
    id: 'oversight',
    titleKey: 'nav.groupOversight',
    destinations: ['audit', 'reports', 'recycle-bin'],
  },
  { id: 'system', titleKey: 'nav.groupSystem', destinations: ['admin'] },
];

/**
 * Exported for the test that keeps the sections in step with the destination table.
 *
 * A destination missing from every section would still render — in a trailing group, because the
 * alternative is a navigation row that silently disappears when somebody adds a screen. The test is
 * what stops anybody relying on that.
 */
export const NAVIGATION_SECTION_IDS: readonly string[] = NAVIGATION_SECTIONS.flatMap(
  (section) => section.destinations,
);

/**
 * The authenticated frame: rail, drawer, top bar, content.
 *
 * Every piece comes from `@munaxa/ui`. Nothing here re-implements a shell, a menu or a
 * navigation list — the product's only visual difference from its siblings is the theme, and a
 * component written here would be a second answer to a question the platform already answers
 * (`ARCHITECTURE.md`).
 *
 * Navigation arrives **already resolved**. Which destinations exist for this caller depends on
 * permissions, and permissions are decided by the server; a client that filtered its own menu
 * would be deciding what it is allowed to see
 * (`docs/architecture/08-permission-model.md` §7).
 */
export function WorkspaceShell({
  destinations,
  displayName,
  description,
  unreadNotifications,
  pendingApprovals = null,
  retentionDue = null,
  signOutAction,
  children,
}: {
  destinations: readonly NavigationDestination[];
  displayName: string;
  /** Secondary line under the name — the tenant this session belongs to. */
  description: string;
  /** Unread messages for the top bar's bell. `null` when the count could not be established. */
  unreadNotifications?: number | null | undefined;
  /** Tasks waiting on this reader, for the count beside Approvals. `null` when unknown. */
  pendingApprovals?: number | null | undefined;
  /**
   * Documents due for a disposal decision. `null` when the reader cannot manage retention or the
   * count could not be established — either way the reminder is not shown.
   */
  retentionDue?: number | null | undefined;
  signOutAction: () => Promise<void>;
  children: ReactNode;
}): ReactNode {
  const translate = useTranslate();

  const renderLink: RenderNavigationLink = ({
    href,
    className,
    children: linkChildren,
    ...rest
  }) => (
    // The platform hands `href` back as a plain string — it must not import a router, so it
    // cannot know Next's route type. The destinations it was given were typed on the way in
    // (`lib/navigation.ts`), which is where a bad route is actually caught.
    <Link href={href as Route} className={className} {...rest}>
      {linkChildren}
    </Link>
  );

  const navigation = (
    <WorkspaceRail
      destinations={destinations}
      renderLink={renderLink}
      pendingApprovals={pendingApprovals}
    />
  );
  const reminder =
    retentionDue === null || retentionDue === 0 ? undefined : (
      <RetentionReminder count={retentionDue} />
    );

  return (
    <AppShellProvider>
      <AppShell
        skipLinkLabel={translate('nav.skipToContent')}
        /*
         * The Docs v2 frame: a flush rail that meets the top bar, separated from the page by one
         * border, and collapsed from the top bar rather than from a control overhanging its edge.
         * Every piece is still the platform's — `variant="flush"` is the platform's own option.
         */
        sidebar={
          <Sidebar
            variant="flush"
            collapsible={false}
            brand={(collapsed) => <Brand collapsed={collapsed} />}
            {...(reminder !== undefined && { footer: reminder })}
          >
            {navigation}
          </Sidebar>
        }
        drawer={
          <NavigationDrawer
            label={translate('nav.menu')}
            brand={<Brand collapsed={false} />}
            {...(reminder !== undefined && { footer: reminder })}
          >
            {navigation}
          </NavigationDrawer>
        }
        topBar={
          <TopBar
            // The card surface, and the rail's 56px: the top bar and the brand row beside it read
            // as one band now that the page canvas is no longer the same colour as a panel.
            className="h-14 bg-card py-0 sm:px-4"
            actions={
              <div className="flex items-center gap-1">
                <NotificationBell count={unreadNotifications ?? null} renderLink={renderLink} />
                <ThemeToggle />
                <LanguageSwitch />
                <UserMenu
                  name={displayName}
                  description={description}
                  label={translate('nav.account')}
                  actions={[
                    {
                      id: 'sign-out',
                      label: translate('auth.signOut'),
                      onSelect: () => {
                        void signOutAction();
                      },
                    },
                  ]}
                />
              </div>
            }
          >
            <SidebarCollapseToggle
              collapseLabel={translate('nav.collapseRail')}
              expandLabel={translate('nav.expandRail')}
            />
            <SidebarTrigger />
            <GlobalSearch />
          </TopBar>
        }
      >
        {children}
      </AppShell>
    </AppShellProvider>
  );
}

/**
 * The product's own navigation rail — Phase 7.1, extracted so it can be looked at.
 *
 * The grouping arrived in Phase 7 and nothing rendered it in isolation, so the visual suite covered
 * the *platform's* `SidebarNav` with fixture groups and covered this product's arrangement not at
 * all. Four named sections in a particular order, built from the destinations the server actually
 * resolved, is a decision worth a baseline: a section renamed, reordered or dropped changes every
 * screen in the application.
 *
 * `renderLink` is optional because the baseline renders this outside a router. In the application
 * the shell passes Next's `Link`; on its own it falls back to the platform's plain anchor, which is
 * the same markup for the purpose of a screenshot.
 */
export function WorkspaceRail({
  destinations,
  renderLink,
  collapsed,
  pendingApprovals = null,
}: {
  readonly destinations: readonly NavigationDestination[];
  readonly renderLink?: RenderNavigationLink | undefined;
  readonly collapsed?: boolean | undefined;
  readonly pendingApprovals?: number | null | undefined;
}): ReactNode {
  const translate = useTranslate();
  const pathname = usePathname();

  const itemFor = (destination: NavigationDestination): NavigationRow => {
    const Icon = iconFor(destination.id);
    return {
      id: destination.id,
      href: destination.href,
      label: translate(destination.labelKey),
      // `size-4` because that is the platform's own icon size — 38 uses across its
      // components, against 2 of anything else. Picking a size here rather than matching
      // theirs is how a design system stops being one.
      //
      // `aria-hidden` because the row already carries its label — visibly when the rail is
      // open, as `sr-only` text when it is collapsed. An icon announced beside it would say
      // the same thing twice.
      icon: <Icon className="size-4" aria-hidden />,
      // Exact match for the workspace root, prefix match for everything else, so a nested
      // route still highlights the section it belongs to.
      active: destination.href === '/' ? pathname === '/' : pathname.startsWith(destination.href),
      // What is waiting on you, beside the place you act on it — Docs v2. Warning tone because it
      // is a queue that ages, the same tone the inbox gives an overdue task. Absent at zero and when
      // unknown: a "0" would claim the queue is empty, which is only true when it was counted.
      ...(destination.id === 'approvals' &&
        pendingApprovals !== null &&
        pendingApprovals > 0 && {
          badge: (
            <Badge tone="warning" className="tabular-nums">
              <span aria-hidden>
                {pendingApprovals > 99 ? '99+' : pendingApprovals.toLocaleString()}
              </span>
              <span className="sr-only">
                {translate('shell.pendingApprovals', { count: pendingApprovals })}
              </span>
            </Badge>
          ),
        }),
    };
  };

  const byId = new Map(destinations.map((destination) => [destination.id, destination]));
  const placed = new Set(NAVIGATION_SECTION_IDS);

  const groups = [
    ...NAVIGATION_SECTIONS.flatMap((section) => {
      const items = section.destinations
        .map((id) => byId.get(id))
        .filter((destination): destination is NavigationDestination => destination !== undefined)
        .map(itemFor);
      // "A group with no visible items should not be passed in at all" — the platform's own
      // instruction, and the reason a caller who holds no administration permission sees no
      // "System" heading rather than an empty one.
      return items.length === 0
        ? []
        : [
            {
              id: section.id,
              // Overview alone has no title — see the note above the table.
              ...(section.titleKey !== null ? { title: translate(section.titleKey) } : {}),
              items,
            },
          ];
    }),
    // Anything the sections above do not name. Empty in practice — `workspace-shell.spec.tsx`
    // asserts it — and present so that adding a destination without touching this file yields a
    // navigation row in the wrong place rather than no navigation row at all.
    ...(() => {
      const rest = destinations.filter((destination) => !placed.has(destination.id)).map(itemFor);
      return rest.length === 0 ? [] : [{ id: 'other', items: rest }];
    })(),
  ];

  return (
    <SidebarNav
      groups={groups}
      label={translate('nav.main')}
      // The current page is an accent row with a brand bar on its leading edge rather than a solid
      // brand block — Docs v2, and the platform's own `indicator` treatment.
      variant="indicator"
      {...(renderLink !== undefined && { renderLink })}
      {...(collapsed !== undefined && { collapsed })}
    />
  );
}

/**
 * The workspace's identity anchor — Phase 7, and the approved logo since the branding phase.
 *
 * It was a bare `<span>`, then a `FileStack` glyph in a `bg-primary` tile: a stand-in for a mark
 * that did not exist yet, and honest about it. The approved `munaxa. docs` lockup exists now and
 * ships with the platform, so the stand-in goes.
 *
 * `ProductLogo` reads the product from `BrandProvider` in the root layout rather than from a prop,
 * which is what makes "never show another product's mark" a thing this file cannot get wrong. It
 * also loads the approved dark-background export in the dark scheme rather than filtering the
 * light one — the `munaxa.` wordmark is neutral ink and has to become white, while the olive
 * symbol and the word "docs" keep their approved colours, which no filter does.
 *
 * `ARCHITECTURE.md`'s rule — branding is configuration, not code — still holds: nothing here names
 * a file, a colour or a ratio.
 *
 * Collapsed, the rail is 84px wide and the platform keeps rendering the brand, so the lockup gives
 * way to the symbol rather than being squeezed. The name is the logo's own accessible name; there
 * is no separate text label to read it out a second time.
 */
function Brand({ collapsed }: { collapsed: boolean }): ReactNode {
  return collapsed ? (
    <ProductLogo variant="symbol" height={26} priority />
  ) : (
    <ProductLogo variant="horizontal" height={24} priority />
  );
}

/**
 * The top bar's notification affordance — Phase 7.5.
 *
 * The product had no bell. Notifications were reachable only by finding the rail row, which means
 * the one thing on the screen that changes without the reader doing anything had no presence in the
 * frame that is always visible. Every reference in the brief puts a counted bell in the top bar, and
 * the API agrees: `GET /notifications/unread-count` exists, in its own words, "precisely so a badge
 * has something to call".
 *
 * **Composed, not built.** `buttonVariants` supplies the ghost shape the theme toggle beside it
 * already uses, `Badge` supplies the count, and the icon is `@munaxa/icons`. `TopBar` documents its
 * `actions` slot as "Trailing content, aligned to the end: notifications, theme toggle, the user
 * menu", so this is the composition the platform intends rather than a new one.
 *
 * **The count sits beside the bell, not on it, and that was a retreat.** The reference screenshots
 * show an overlaid pill on the glyph's corner, which was built first and then looked at: the
 * platform has no overlay-count primitive, so reaching that shape meant pinning `Badge` with
 * `absolute -end-1 -top-1 min-w-4 px-1 text-[10px] leading-4`. Rendered and zoomed, it was a tall
 * pink rectangle floating beside the bell rather than a pill on it — and the classes that produced
 * it are precisely the "hardcode visual values to imitate the screenshots" this phase forbids.
 * Inline is what `Badge` is for, and it is what `NavigationItem.badge` — the platform's only badge
 * slot — also means by "trailing content". The gap is written up in the Phase 7.5 report; it is not
 * worked around here.
 *
 * **The count is spoken, not just shown.** The button's accessible name is the plain destination;
 * the count follows as visually-hidden text built from `notifications.unreadCount`, the message the
 * notifications screen already uses. Reusing it rather than writing a new sentence is deliberate —
 * that key's Arabic was reviewed under the numeral policy in Phase 7.4C, including the dual that
 * carries no digit, and a new string here would be new Arabic written without that review.
 *
 * `null` means the count could not be established and renders no badge at all. A zero badge would
 * claim "you are up to date"; an absent one claims nothing, which is the truth when the request
 * failed.
 */
function NotificationBell({
  count,
  renderLink,
}: {
  readonly count: number | null;
  readonly renderLink: RenderNavigationLink;
}): ReactNode {
  const translate = useTranslate();
  const label = translate('nav.notifications');

  const badged = count !== null && count > 0;

  return renderLink({
    href: '/notifications',
    // `buttonVariants` rather than wrapping a `Button`, because the platform's `Button` is a plain
    // forwarded `<button>` with no `asChild`. This is the escape hatch it ships for exactly this
    // case — "usable on non-`<button>` elements (e.g. `<a>` CTAs styled as buttons)" — so the bell
    // is the same ghost shape as the theme toggle beside it without a second button style.
    //
    // `icon` when bare, `sm` when it carries a count, because an icon button is a square and a
    // square cannot hold a glyph and a number.
    className: buttonVariants('ghost', badged ? 'sm' : 'icon', badged ? 'gap-2' : undefined),
    'aria-current': undefined,
    title: undefined,
    children: (
      <>
        <Bell className="size-4" aria-hidden />
        {badged && (
          // Inline beside the glyph, not overlaid on it — see the note above the component on why
          // the overlay was abandoned. `Badge` with no sizing overrides at all: whatever the
          // platform decides a badge looks like is what appears here.
          <Badge tone="danger" aria-hidden>
            {/* 99+ rather than a four-digit pill that would push the user menu around. */}
            {count > 99 ? '99+' : count.toLocaleString()}
          </Badge>
        )}
        <span className="sr-only">
          {badged ? `${label}, ${translate('notifications.unreadCount', { count })}` : label}
        </span>
      </>
    ),
  });
}

/**
 * Light/dark switching.
 *
 * `scheme` is `null` until the effect has run, which is the server render and the first paint.
 * The button renders its label from that state, so it must not assume either value before then
 * — labelling it "Dark" on the server and flipping to "Light" on hydration is a visible glitch
 * and a hydration mismatch.
 */
export function ThemeToggle(): ReactNode {
  const translate = useTranslate();
  const { scheme, toggle } = useTheme({ storageKey: 'edms.theme' });
  const label =
    scheme === null
      ? translate('nav.appearance')
      : translate(scheme === 'dark' ? 'nav.lightMode' : 'nav.darkMode');

  return (
    // `ghost` is what the hand-written classes here were already imitating — the same height,
    // radius, padding and `hover:bg-accent`. Stating it once in the platform is the difference
    // between a button that matches the top bar and one that matches it until either changes.
    //
    // **An icon rather than the word** — Phase 7. The label used to be the button's content, and it
    // is three different lengths: "Appearance" on the server and the first paint, then "Light" or
    // "Dark" after hydration. The top bar reflowed on load and again on every toggle. The word is
    // still the accessible name, which is the half that matters, and it now describes what the
    // button *does* rather than only what it is.
    //
    // The sun and the moon are the two states, not one icon rotating: rendering neither until the
    // effect has run is what keeps the server's markup and the first client render identical.
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={label}>
      {scheme === null ? (
        <SunMoon className="size-4" aria-hidden />
      ) : scheme === 'dark' ? (
        <Sun className="size-4" aria-hidden />
      ) : (
        <Moon className="size-4" aria-hidden />
      )}
    </Button>
  );
}

/**
 * Search from anywhere — the top bar's search box, Docs v2.
 *
 * Search had its own screen and nothing else: finding a document from the record page meant
 * leaving it for the search page first. Every document workspace a reader has used before puts the
 * box in the frame, so this does — and it is the *same* search, not a second one. Submitting goes
 * to `/search?q=…`, which is the search screen's own URL, so its ranking, permission filtering,
 * facets and saved searches all apply unchanged.
 *
 * ⌘K / Ctrl+K moves focus here from anywhere in the workspace. The shortcut is shown in the box
 * and is part of its accessible description, so it is discoverable without a help page.
 *
 * Uncontrolled and keyed on the route's query: arriving on a search page shows what was searched,
 * and arriving anywhere else shows an empty box, rather than a stale query following the reader
 * from screen to screen.
 */
function GlobalSearch(): ReactNode {
  const translate = useTranslate();
  const router = useRouter();
  const pathname = usePathname();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const shortcut =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)
      ? '⌘K'
      : 'Ctrl K';

  return (
    <form
      role="search"
      aria-label={translate('nav.globalSearch')}
      className="relative ms-2 hidden max-w-[460px] min-w-60 flex-1 sm:block"
      onSubmit={(event) => {
        event.preventDefault();
        const query = new FormData(event.currentTarget).get('q');
        const text = typeof query === 'string' ? query.trim() : '';
        router.push(text === '' ? '/search' : `/search?q=${encodeURIComponent(text)}`);
      }}
    >
      <Search
        className="text-muted-foreground pointer-events-none absolute inset-y-0 start-3 my-auto size-4"
        aria-hidden
      />
      <Input
        ref={input}
        // Re-mounted per route so the box never carries a query into a screen it does not describe.
        key={pathname}
        name="q"
        type="search"
        aria-label={translate('nav.globalSearch')}
        aria-keyshortcuts="Meta+K Control+K"
        placeholder={translate('nav.globalSearchPlaceholder')}
        className="bg-secondary h-9 ps-9 pe-16"
      />
      <kbd
        aria-hidden
        className="border-border bg-card text-muted-foreground pointer-events-none absolute inset-y-0 end-2 my-auto h-fit rounded-md border px-1.5 font-sans text-[11px]"
      >
        {shortcut}
      </kbd>
    </form>
  );
}

/**
 * English ⇄ Arabic — Docs v2.
 *
 * The control is labelled in the language it switches *to*, in that language: an Arabic reader
 * landing on the English product looks for "العربية", not for "Arabic". Its accessible name says
 * what it does in the current language.
 *
 * The switch is a cookie written on the server followed by a refresh, because direction is set on
 * `<html>` by the root layout on the server — see `lib/locale.ts`.
 */
export function LanguageSwitch(): ReactNode {
  const translate = useTranslate();
  const { locale } = useSession();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const next = locale === Locale.AR ? Locale.EN : Locale.AR;

  return (
    <Button
      variant="outline"
      size="sm"
      lang={next}
      disabled={pending}
      aria-label={translate('nav.switchLanguageLabel')}
      onClick={() => {
        startTransition(async () => {
          await switchLocale(next);
          router.refresh();
        });
      }}
    >
      {translate('nav.switchLanguage')}
    </Button>
  );
}

/**
 * The rail's retention reminder — Docs v2.
 *
 * Shown only to somebody who can act on it (the layout asks only when the reader holds
 * `retention:manage`) and only when something is due. A permanent card saying "nothing due" would
 * be a card people learn to stop reading, which is the one property a reminder cannot have.
 */
function RetentionReminder({ count }: { readonly count: number }): ReactNode {
  const translate = useTranslate();
  return (
    <div className="border-border bg-muted/40 flex flex-col gap-1.5 rounded-lg border p-2.5">
      <span className="text-muted-foreground text-[11px]">{translate('shell.retentionTitle')}</span>
      <span className="text-xs leading-snug">{translate('shell.retentionDue', { count })}</span>
      <Link
        href="/admin/retention"
        className="text-primary-strong text-xs font-semibold hover:underline"
      >
        {translate('shell.retentionOpen')}
      </Link>
    </div>
  );
}
