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

import { en } from '@edms/i18n';

import { useTranslate } from '../app/providers';
import type { NavigationDestination } from '../lib/navigation';

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
      items: destinations.map((destination) => ({
        id: destination.id,
        href: destination.href,
        label: translate(destination.labelKey),
        // Exact match for the workspace root, prefix match for everything else, so a nested
        // route still highlights the section it belongs to.
        active: destination.href === '/' ? pathname === '/' : pathname.startsWith(destination.href),
      })),
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
