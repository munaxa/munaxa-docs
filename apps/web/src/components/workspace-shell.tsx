'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  AppShell,
  AppShellProvider,
  Button,
  NavigationDrawer,
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
  Files,
  House,
  type Icon,
  ScrollText,
  Search,
  Settings,
  Trash2,
  UserRoundCheck,
} from '@munaxa/icons';

import { en } from '@edms/i18n';

import { useTranslate } from '../app/providers';
import type { NavigationDestination } from '../lib/navigation';

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
  signOutAction,
  children,
}: {
  destinations: readonly NavigationDestination[];
  displayName: string;
  /** Secondary line under the name — the tenant this session belongs to. */
  description: string;
  signOutAction: () => Promise<void>;
  children: ReactNode;
}): ReactNode {
  const translate = useTranslate();
  const pathname = usePathname();

  const groups = [
    {
      id: 'main',
      items: destinations.map((destination) => {
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
          active:
            destination.href === '/' ? pathname === '/' : pathname.startsWith(destination.href),
        };
      }),
    },
  ];

  const renderLink = ({
    href,
    className,
    children: linkChildren,
    ...rest
  }: {
    href: string;
    className?: string;
    children: ReactNode;
  }): ReactNode => (
    // The platform hands `href` back as a plain string — it must not import a router, so it
    // cannot know Next's route type. The destinations it was given were typed on the way in
    // (`lib/navigation.ts`), which is where a bad route is actually caught.
    <Link href={href as Route} className={className} {...rest}>
      {linkChildren}
    </Link>
  );

  const navigation = (
    <SidebarNav groups={groups} label={translate('nav.main')} renderLink={renderLink} />
  );

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

function Brand(): ReactNode {
  return <span className="text-sm font-semibold">{en.app.name}</span>;
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

  return (
    // `ghost` is what the hand-written classes here were already imitating — the same height,
    // radius, padding and `hover:bg-accent`. Stating it once in the platform is the difference
    // between a button that matches the top bar and one that matches it until either changes.
    <Button variant="ghost" onClick={toggle} aria-label={translate('nav.appearance')}>
      {scheme === null
        ? translate('nav.appearance')
        : translate(scheme === 'dark' ? 'nav.lightMode' : 'nav.darkMode')}
    </Button>
  );
}
