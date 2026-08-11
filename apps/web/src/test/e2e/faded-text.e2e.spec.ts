import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import {
  WEB_URL,
  cleanUpFixtures,
  seedFixture,
  signInAndCapture,
  startServers,
  stopServers,
  type Fixture,
  type Servers,
} from './servers.js';
import { setTheme, settleColours } from './theme.js';

/**
 * Every faded piece of text the product actually renders, measured — Phase 8.3.
 *
 * Phase 8.2 fixed one faded token and, in doing so, established that the interesting question is
 * never "which files contain `/70`". `text-muted-foreground/70` on a 10px heading failed at 2.79:1;
 * `opacity-70` on a `text-sm` paragraph that inherits `text-foreground` is a different mechanism
 * over a different token and may pass comfortably. Source cannot tell those apart. This suite does
 * not read source at all: it walks what the browser painted, keeps the elements whose text is faded
 * by *any* mechanism, and measures each one.
 *
 * The three mechanisms it has to treat alike, because a reader cannot tell them apart:
 *
 *   - `opacity-70` on the element (or on any ancestor — they multiply);
 *   - an alpha-bearing colour, `text-muted-foreground/70` → `oklab(… / 0.7)`;
 *   - both at once.
 *
 * It is a measurement instrument, not a guard. The only assertion is that the sweep found something
 * to measure — a sweep that silently matched nothing would report "no defects" and mean "no data".
 * Findings become guarded assertions in the suites that own them, once classified.
 */

const require_ = createRequire(import.meta.url);
const AXE_PATH = require_.resolve('axe-core/axe.min.js');

const CHROMIUM_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** WCAG 1.4.3: large text is ≥24px, or ≥18.66px when bold. Everything else needs 4.5:1. */
const LARGE_PX = 24;
const LARGE_BOLD_PX = 18.66;

interface Faded {
  readonly route: string;
  readonly theme: 'light' | 'dark';
  readonly text: string;
  readonly classes: string;
  readonly fontSizePx: number;
  readonly fontWeight: number;
  readonly colour: string;
  /** Painting layers behind the text, outermost first. */
  readonly background: readonly string[];
  /** Product of every `opacity` from the element up to the root. */
  readonly opacity: number;
  readonly ratio: number;
  readonly threshold: number;
  readonly passes: boolean;
}

/**
 * The routes that render the inventoried candidates, plus the two Phase 8.2 touched.
 *
 * One load each — the rate limit lesson from Phase 7.8 is that a dashboard render costs a dozen
 * requests and the API allows 300/60s. Both themes are measured from the same load.
 */
const ROUTES = [
  '/',
  '/documents',
  '/documents/recent',
  '/approvals',
  '/audit',
  '/reports',
  '/notifications',
  '/search',
  '/admin/users',
  '/admin/numbering',
  '/delegations',
] as const;

describe('faded text across the product', () => {
  let fixture: Fixture;
  let servers: Servers | null = null;
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  const found: Faded[] = [];
  const unreachable: string[] = [];

  beforeAll(async () => {
    fixture = seedFixture();
    servers = await startServers(fixture);
    browser = await chromium.launch(
      existsSync(CHROMIUM_PATH) ? { executablePath: CHROMIUM_PATH } : {},
    );
    const state = await signInAndCapture(
      browser,
      WEB_URL,
      fixture.signer.email,
      fixture.password,
      fixture.slug,
    );
    context = await browser.newContext({
      storageState: state,
      viewport: { width: 1280, height: 900 },
    });
    page = await context.newPage();

    /** Measure whatever is currently loaded, in both themes, from the one load. */
    const sweepLoaded = async (route: string): Promise<void> => {
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        // Phase 7.9: a reading taken during `transition-colors` is the interpolated colour, and one
        // such reading became a platform finding that was not real.
        await settleColours(page);

        const measured = await page.evaluate(
          ({ largePx, largeBoldPx }) => {
            /*
             * Composite through a 1×1 canvas — Phase 8.2's correction, generalised.
             *
             * A faded colour returns as `oklab(… / 0.7)`; parsing that with an `rgba()` regex
             * silently yields black and reports 21:1. Painting the background and then the
             * foreground makes the browser do the colour-space conversion *and* the alpha blend.
             * Element `opacity` is applied as `globalAlpha` in the same operation, so both
             * mechanisms composite by the same path and a reader-equivalent pixel comes back.
             */
            const canvas = document.createElement('canvas');
            canvas.width = 1;
            canvas.height = 1;
            const context2d = canvas.getContext('2d');

            const pixel = (
              background: readonly string[],
              foreground?: string,
              alpha = 1,
            ): readonly number[] => {
              if (context2d === null) {
                return [0, 0, 0];
              }
              context2d.globalAlpha = 1;
              context2d.clearRect(0, 0, 1, 1);
              for (const layer of background) {
                context2d.fillStyle = layer;
                context2d.fillRect(0, 0, 1, 1);
              }
              if (foreground !== undefined) {
                context2d.globalAlpha = alpha;
                context2d.fillStyle = foreground;
                context2d.fillRect(0, 0, 1, 1);
                context2d.globalAlpha = 1;
              }
              const data = context2d.getImageData(0, 0, 1, 1).data;
              return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
            };

            const luminance = (rgb: readonly number[]): number => {
              const channel = (value: number): number => {
                const c = value / 255;
                return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
              };
              return (
                0.2126 * channel(rgb[0] ?? 0) +
                0.7152 * channel(rgb[1] ?? 0) +
                0.0722 * channel(rgb[2] ?? 0)
              );
            };

            /**
             * Every painting layer behind the text, outermost first.
             *
             * Returning only the nearest painting ancestor is wrong whenever that ancestor is
             * itself translucent — `Badge` is `bg-primary/15`, so the nearest background is 15%
             * primary and the eye sees it blended over the card beneath. Painting that colour alone
             * onto a cleared canvas composites it against nothing and reports a luminance no reader
             * ever sees. The stack is collected up to and including the first opaque layer, then
             * painted in that order.
             */
            const backgroundStackOf = (from: Element): readonly string[] => {
              const layers: string[] = [];
              let node: Element | null = from;
              while (node !== null) {
                const colour = getComputedStyle(node).backgroundColor;
                if (colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent') {
                  layers.push(colour);
                  if (!/\/\s*0?\.\d+\s*\)|rgba\([^)]*,\s*0?\.\d+\s*\)/.test(colour)) break;
                }
                node = node.parentElement;
              }
              const root = getComputedStyle(document.body).backgroundColor;
              if (layers.length === 0) layers.push(root);
              else layers.push(root);
              return layers.reverse();
            };

            /** Opacities multiply down the tree, so an ancestor's fade counts against the text. */
            const effectiveOpacity = (from: Element): number => {
              let node: Element | null = from;
              let total = 1;
              while (node !== null) {
                total *= Number(getComputedStyle(node).opacity);
                node = node.parentElement;
              }
              return total;
            };

            /** Text this element renders itself, rather than text belonging to its descendants. */
            const ownText = (element: Element): string =>
              [...element.childNodes]
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent ?? '')
                .join('')
                .trim();

            const out: Record<string, unknown>[] = [];
            for (const element of document.querySelectorAll('*')) {
              const text = ownText(element);
              if (text === '') continue;
              if (element.closest('[aria-hidden="true"]') !== null) continue;

              const box = element.getBoundingClientRect();
              if (box.width === 0 || box.height === 0) continue;

              const style = getComputedStyle(element);
              if (style.visibility === 'hidden' || style.display === 'none') continue;

              const opacity = effectiveOpacity(element);
              const translucent = (value: string): boolean =>
                /\/\s*0?\.\d+\s*\)|rgba\([^)]*,\s*0?\.\d+\s*\)|color-mix\(/.test(value);
              const background = backgroundStackOf(element);
              /*
               * Three ways text ends up composited rather than solid, and a reader cannot tell
               * them apart: a faded element, a faded foreground token, or a faded surface beneath
               * it. `Badge` is the third — `bg-primary/15` over the card — and a filter that looked
               * only at the foreground would have declared it out of scope and measured nothing.
               */
              const alphaBearing = translucent(style.color);
              const alphaSurface = background.some(translucent);
              if (opacity >= 0.999 && !alphaBearing && !alphaSurface) continue;

              const back = luminance(pixel(background));
              const front = luminance(pixel(background, style.color, opacity));
              const [hi, lo] = front > back ? [front, back] : [back, front];
              const ratio = Number((((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)).toFixed(2));

              const fontSizePx = Number.parseFloat(style.fontSize);
              const fontWeight = Number(style.fontWeight);
              const large =
                fontSizePx >= largePx || (fontSizePx >= largeBoldPx && fontWeight >= 700);

              out.push({
                text: text.slice(0, 40),
                classes: element.className.toString().slice(0, 160),
                fontSizePx,
                fontWeight,
                colour: style.color,
                background: [...background],
                opacity: Number(opacity.toFixed(3)),
                ratio,
                threshold: large ? 3 : 4.5,
                passes: ratio >= (large ? 3 : 4.5),
              });
            }
            return out;
          },
          { largePx: LARGE_PX, largeBoldPx: LARGE_BOLD_PX },
        );

        for (const entry of measured) {
          found.push({ route, theme, ...entry } as Faded);
        }
      }

      await setTheme(page, 'light');
    };

    for (const route of ROUTES) {
      const response = await page.goto(`${WEB_URL}${route}`, { waitUntil: 'networkidle' });
      if (response !== null && response.status() >= 400) {
        unreachable.push(`${route} → HTTP ${String(response.status())}`);
        continue;
      }
      await sweepLoaded(route);
    }

    /*
     * The document record, reached the way a person reaches it.
     *
     * Most of the inventoried `opacity-70` sites live in panels — revisions, approvals, preview,
     * signatures — that only mount once a document is open. Measuring the list routes alone would
     * have reported "nothing faded found" and meant "never rendered it". The fixture writes one
     * document, so the link is followed rather than a URL guessed; if the row is not there, that
     * is recorded as unreachable instead of worked around.
     */
    const anchorHref = async (): Promise<string | null> =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('a[href]')]
            .map((a) => a.getAttribute('href') ?? '')
            .find((value) => /^\/documents\/[0-9a-f-]{36}$/.test(value)) ?? null,
      );

    // `recent-screen` renders real anchors; the library list has none — `DataGrid` opens a row on
    // double-click or Enter (`onRowActivate`), so it is opened the way a person opens it. A single
    // click does nothing, which is why the first attempt timed out waiting for a navigation.
    await page.goto(`${WEB_URL}/documents/recent`, { waitUntil: 'networkidle' });
    let href = await anchorHref();
    if (href === null) {
      await page.goto(`${WEB_URL}/documents`, { waitUntil: 'networkidle' });
      const row = page.locator('tbody tr').first();
      if ((await row.count()) > 0) {
        await row.dblclick();
        await page.waitForURL(/\/documents\/[0-9a-f-]{36}$/, { timeout: 15_000 });
        href = new URL(page.url()).pathname;
      }
    }
    if (href === null) {
      unreachable.push('/documents/[documentId] → no document row in recent or the library list');
    } else {
      if (!page.url().endsWith(href)) {
        await page.goto(`${WEB_URL}${href}`, { waitUntil: 'networkidle' });
      }
      await sweepLoaded('/documents/[documentId]');
    }
  }, 600_000);

  afterAll(async () => {
    await context?.close();
    await browser?.close();
    if (servers !== null) await stopServers(servers);
    cleanUpFixtures();
  });

  it('found faded text to measure', () => {
    if (unreachable.length > 0) {
      console.log('[faded-text unreachable]', JSON.stringify(unreachable));
    }
    console.log('[faded-text routes]', JSON.stringify(ROUTES));
    console.log('[faded-text total]', found.length);
    // A sweep that matched nothing would report "no defects" and mean "no data".
    expect(
      found.length,
      'the sweep matched no faded text at all — it is not measuring',
    ).toBeGreaterThan(0);
  });

  /**
   * What axe makes of the same surfaces — Phase 8.3, Part 11.
   *
   * Both `violations` and `incomplete` are recorded. The distinction is the point: axe computes a
   * contrast ratio only when it can resolve an opaque background, and reports everything else as
   * *incomplete* — "needs review" — rather than as a violation. A translucent surface like
   * `bg-primary/15` is exactly that case, so a suite that watched only `violations` would report a
   * clean page over text this suite measures at 4.31:1. Silence from axe is not a retraction.
   */
  it('records what axe sees on the routes carrying the failing surfaces', async () => {
    const seen: Record<string, unknown> = {};
    for (const route of ['/documents', '/'] as const) {
      await page.goto(`${WEB_URL}${route}`, { waitUntil: 'networkidle' });
      for (const theme of ['light', 'dark'] as const) {
        await setTheme(page, theme);
        await settleColours(page);
        await page.addScriptTag({ path: AXE_PATH });
        const result = await page.evaluate(async () => {
          const run = (
            window as unknown as {
              axe: {
                run: (
                  ctx: Document,
                  options: unknown,
                ) => Promise<{
                  violations: { id: string; impact: string; nodes: { target: string[] }[] }[];
                  incomplete: { id: string; nodes: { target: string[] }[] }[];
                }>;
              };
            }
          ).axe;
          const outcome = await run.run(document, { runOnly: ['color-contrast'] });
          return {
            violations: outcome.violations.flatMap((v) =>
              v.nodes.map((n) => `${v.impact}: ${v.id}: ${n.target.join(' ')}`.slice(0, 140)),
            ),
            incomplete: outcome.incomplete.flatMap((i) =>
              i.nodes.map((n) => `${i.id}: ${n.target.join(' ')}`.slice(0, 120)),
            ),
          };
        });
        seen[`${route} ${theme}`] = result;
      }
      await setTheme(page, 'light');
    }
    console.log('[faded-text axe]', JSON.stringify(seen, null, 1));
    expect(Object.keys(seen).length).toBe(4);
  }, 240_000);

  /**
   * Keyboard reachability for the one interactive thing this phase touched — Part 12.
   *
   * The two confirmed defects are a `Badge` and an `Avatar` initial, neither of which is focusable
   * or interactive, so there is no keyboard behaviour to assert on them and claiming otherwise
   * would be theatre. What *is* interactive is the grid row that opens a document: `DataGrid` wires
   * `onRowActivate` to double-click **and** to Enter, and the Enter path is the one a keyboard user
   * depends on. It is exercised here rather than read off the source.
   */
  it('opens a document row from the keyboard, not only by double-click', async () => {
    await page.goto(`${WEB_URL}/documents`, { waitUntil: 'networkidle' });

    /*
     * `DataGrid` is a grid, so focus roves over cells rather than rows.
     *
     * The first attempt focused the `<tr>` and pressed Enter, and nothing happened — the row is not
     * focusable and never was. That is the test being wrong about the interaction model, not the
     * product being inaccessible: the row carries `onDoubleClick`, while the keyboard path is a
     * cell holding `tabindex="0"` under a roving-focus scheme, and Enter on a cell with nothing
     * focusable inside falls through to `onRowActivate`. Recorded because "keyboard access is
     * broken" was the wrong conclusion available here, and the source said otherwise.
     */
    const cell = page.locator('[data-cell][tabindex="0"]').first();
    expect(await cell.count(), 'no roving-focus cell to start from').toBeGreaterThan(0);

    /*
     * Roving focus starts on the header (`{ row: -1, col: 0 }`), so the single `tabindex="0"` cell
     * is in `thead` until the user moves down. Scoping the search to `tbody` found nothing and the
     * previous attempt read that as "no keyboard path", which was the second wrong conclusion this
     * test produced about a grid that turns out to implement the pattern correctly. ArrowDown is
     * how a keyboard user gets from the header into the first row.
     */
    await cell.focus();
    await page.keyboard.press('ArrowDown');
    const focusedIsCell = await page.evaluate(
      () =>
        (document.activeElement?.matches('[data-cell]') ?? false) &&
        document.activeElement?.closest('tbody') !== null,
    );
    /* A focus ring a keyboard user cannot see is not focus — 2.4.7. */
    const focusVisible = await page.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return null;
      const style = getComputedStyle(active);
      return {
        outlineWidth: style.outlineWidth,
        outlineStyle: style.outlineStyle,
        boxShadow: style.boxShadow.slice(0, 60),
      };
    });

    /*
     * Enter reaches *into* a cell that holds something focusable, and only falls through to
     * `onRowActivate` on a cell that holds nothing. Column 0 is the selection checkbox, so Enter
     * there focuses the checkbox — correctly — and the row does not open. That is the grid's
     * documented behaviour rather than a defect, so the walk continues rightwards to the first
     * inert cell, which is the one a keyboard user activates the row from.
     */
    let inertCell = false;
    for (let step = 0; step < 6 && !inertCell; step += 1) {
      inertCell = await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null || !active.matches('[data-cell]')) return false;
        return active.querySelector('button, a[href], input, select, textarea') === null;
      });
      if (!inertCell) await page.keyboard.press('ArrowRight');
    }

    const landedOn = await page.evaluate(
      () => document.activeElement?.getAttribute('aria-colindex') ?? '?',
    );
    await page.keyboard.press('Enter');
    const navigated = await page
      .waitForURL(/\/documents\/[0-9a-f-]{36}$/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    console.log(
      '[faded-text keyboard]',
      JSON.stringify({
        focusedIsCell,
        focusVisible,
        inertCell,
        landedOn,
        navigated,
        url: page.url(),
      }),
    );
    expect(focusedIsCell, 'the grid cell did not take focus, so Enter could never reach it').toBe(
      true,
    );
    expect(navigated, 'Enter on a focused cell did not activate the row').toBe(true);
  }, 120_000);

  it('reports every distinct faded surface, worst ratio first', () => {
    // Distinct by what a designer would change: the classes, the size and the theme.
    const distinct = new Map<string, Faded>();
    for (const entry of found) {
      const key = `${entry.theme}|${entry.classes}|${String(entry.fontSizePx)}`;
      const worst = distinct.get(key);
      if (worst === undefined || entry.ratio < worst.ratio) distinct.set(key, entry);
    }
    const rows = [...distinct.values()].sort((a, b) => a.ratio - b.ratio);
    console.log('[faded-text surfaces]', JSON.stringify(rows, null, 1));

    const failing = rows.filter((row) => !row.passes);
    console.log('[faded-text failing]', JSON.stringify(failing, null, 1));
    console.log('[faded-text failing count]', failing.length);
    expect(rows.length).toBeGreaterThan(0);
  });
});
