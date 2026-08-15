import type { Page } from 'playwright';

import { en } from '@edms/i18n';

/**
 * Driving and measuring the theme, shared by the suites that do both — Phase 8.2.
 *
 * Extracted rather than copied: the second suite to need these was the one measuring navigation
 * contrast, and a second copy of `settleColours` is a second chance to reintroduce the bug it
 * exists to prevent.
 */

/**
 * Switch the theme the way a person does.
 *
 * The top bar's control is a single button whose label names the theme it will switch *to*, so it
 * is clicked only when the document is not already in the wanted state — clicking blindly toggles
 * away from it on the second call. Nothing sets `.dark` directly and no CSS is injected.
 *
 * It waits for the control to know which theme it is in first: `ThemeToggle`'s label is
 * `nav.appearance` until its effect has run — deliberately, so the server's markup and the first
 * client render agree — and only then becomes "Light" or "Dark". Clicking by name before hydration
 * finishes waits thirty seconds for a button that does not exist yet.
 */
/**
 * Resolves once the client has hydrated and its effects have run — Phase 8.23.
 *
 * The signal is `ThemeToggle`'s label, for the reason `setTheme` documents below: it reads
 * `nav.appearance` in the server's markup and in the first client render, and becomes "Light" or
 * "Dark" only after the effect that resolves the theme. So a resolved label means effects have run.
 *
 * It is extracted because a second suite needed it. `shell.e2e` measures how a person reaches the
 * navigation at each width, and below `md` that is the drawer trigger — which `TopBar` renders only
 * when `isMobile` is true, and `isMobile` is `matchMedia` read in an effect. Before hydration there
 * is no trigger, so a measurement taken too early reports "no way to reach navigation" about a
 * product that offers one. On this container hydration always won that race; the first CI run of
 * the end-to-end suite lost it, on `/search` at 640px.
 *
 * Deliberately a *different* fact from anything the callers assert: waiting for the trigger itself
 * would have made those assertions unable to fail.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    (labels) =>
      [...document.querySelectorAll('button[aria-label]')].some((button) =>
        labels.includes(button.getAttribute('aria-label') ?? ''),
      ),
    [en.nav.lightMode, en.nav.darkMode] as readonly string[],
  );
}

export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await waitForHydration(page);

  const already = await page.evaluate(() => document.documentElement.classList.contains('dark'));
  if (already === (theme === 'dark')) {
    return;
  }
  await page
    .getByRole('button', {
      name: theme === 'dark' ? en.nav.darkMode : en.nav.lightMode,
      exact: true,
    })
    .click();
  await page.waitForFunction(
    (wantDark) => document.documentElement.classList.contains('dark') === wantDark,
    theme === 'dark',
  );
}

/**
 * Wait for colour transitions to finish before measuring one — Phase 7.9, and the correction it
 * exists to make.
 *
 * `SidebarNav` puts `transition-colors` on every rail item. Phase 7.8 measured the rail immediately
 * after clicking the theme control and recorded 3.57:1 in dark, wrote it up as a platform token
 * gap, and guarded it. It was a **transition artefact**: `getComputedStyle().color` returns the
 * interpolated value while a transition is in flight, so the reading was the light colour part-way
 * to the dark one. Settled, the same items measure 4.97:1 light and 6.89:1 dark.
 *
 * Two samples that agree, rather than a fixed sleep: a sleep is a guess about a duration the
 * platform is free to change.
 */
export async function settleColours(page: Page): Promise<void> {
  const sample = (): Promise<string> =>
    page.evaluate(() =>
      [...document.querySelectorAll('nav a, nav p')]
        .map((node) => getComputedStyle(node).color)
        .join('|'),
    );

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const first = await sample();
    await page.waitForTimeout(120);
    if (first === (await sample())) {
      return;
    }
  }
  throw new Error('the navigation never stopped animating its colours');
}
