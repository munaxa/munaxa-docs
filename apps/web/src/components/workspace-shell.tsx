'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  AppShell,
  AppShellProvider,
  Badge,
  Button,
  buttonVariants,
  NavigationDrawer,
  type RenderNavigationLink,
  Sidebar,
  SidebarNav,
  SidebarTrigger,
  TopBar,
  UserMenu,
  useTheme,
} from '@munaxa/ui';

import {
  Bell,
  ChartColumn,
  FileCheck,
  FileText,
  FileStack,
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

import { type MessageKey, en } from '@edms/i18n';

import { useTranslate } from '../app/providers';
import type { NavigationDestination } from '../lib/navigation';

/** One rendered rail row, in the shape `SidebarNav` takes. */
interface NavigationRow {
  readonly id: string;
  readonly href: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly active: boolean;
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
 * Whether the section headings are rendered — Phase 7.1, and it is currently `false`.
 *
 * Phase 7 gave the rail four named sections. Phase 7.1 added a baseline for the product's own
 * arrangement, which had never been rendered anywhere a contrast check could see it, and the check
 * failed immediately: `SidebarNav` styles a group heading `text-muted-foreground/70` at
 * `text-[10px]`, which is **2.78:1** on the Docs light surface against the 4.5:1 WCAG 2.1 AA
 * requires. Phase 7 shipped four of them without knowing.
 *
 * There is no product-side fix. The classes are the platform component's own, and both remedies
 * available here — overriding platform styling, or hardcoding a colour — are forbidden by
 * `ARCHITECTURE.md` and by this phase's own brief. So the words pause and the accessibility does
 * not: `NavigationGroup.title` is optional by the platform's design, an untitled group still
 * renders as its own separated run (the nav's `gap-5`), and the four sections stay in the order and
 * the shape Phase 7 gave them.
 *
 * The titles are kept in the table below rather than deleted, because restoring them is this one
 * constant once the palette or the opacity is fixed upstream. The Phase 7.1 report carries the
 * measurement and the request.
 */
const SECTION_HEADINGS_ACCESSIBLE = false;

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
  signOutAction,
  children,
}: {
  destinations: readonly NavigationDestination[];
  displayName: string;
  /** Secondary line under the name — the tenant this session belongs to. */
  description: string;
  /** Unread messages for the top bar's bell. `null` when the count could not be established. */
  unreadNotifications?: number | null | undefined;
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

  const navigation = <WorkspaceRail destinations={destinations} renderLink={renderLink} />;

  return (
    <AppShellProvider>
      <AppShell
        skipLinkLabel={translate('nav.skipToContent')}
        sidebar={<Sidebar brand={<Brand />}>{navigation}</Sidebar>}
        drawer={<NavigationDrawer label={translate('nav.menu')}>{navigation}</NavigationDrawer>}
        topBar={
          <TopBar
            actions={
              <div className="flex items-center gap-1">
                <NotificationBell count={unreadNotifications ?? null} renderLink={renderLink} />
                <ThemeToggle />
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
            <SidebarTrigger />
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
}: {
  readonly destinations: readonly NavigationDestination[];
  readonly renderLink?: RenderNavigationLink | undefined;
  readonly collapsed?: boolean | undefined;
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
              ...(SECTION_HEADINGS_ACCESSIBLE && section.titleKey !== null
                ? { title: translate(section.titleKey) }
                : {}),
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
      {...(renderLink !== undefined && { renderLink })}
      {...(collapsed !== undefined && { collapsed })}
    />
  );
}

/**
 * The workspace's identity anchor — Phase 7.
 *
 * It was a bare `<span>`: the top-left of the application, which is the first thing a reader's eye
 * lands on, said the product's name in the same weight as a navigation row. A mark beside the name
 * is what makes the rail read as a product rather than as a menu, and it is the one place a small
 * amount of visual assertion is worth spending.
 *
 * Built from a token class and a platform icon rather than an asset: the brand is `bg-primary`, so
 * it retunes with the palette in `munaxa-platform` and needs no image to ship, no dark-mode variant
 * and no second file to keep in step. `ARCHITECTURE.md`'s rule — branding is configuration, not
 * code — is satisfied by using the semantic colour rather than a picture of it.
 *
 * The mark is `aria-hidden`; the name beside it is the accessible one, and when the rail collapses
 * the platform hides the whole brand rather than truncating it.
 */
function Brand(): ReactNode {
  return (
    <span className="flex items-center gap-2">
      <span
        className="bg-primary text-primary-foreground flex size-6 shrink-0 items-center justify-center rounded-md"
        aria-hidden
      >
        <FileStack className="size-3.5" />
      </span>
      <span className="truncate text-sm font-semibold tracking-tight">{en.app.name}</span>
    </span>
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
function ThemeToggle(): ReactNode {
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
