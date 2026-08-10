import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { type Browser, type Page, chromium } from 'playwright';

/**
 * The real-browser harness: colour contrast, and visual regression.
 *
 * ## Why a browser at all, when axe already runs in jsdom
 *
 * jsdom has no cascade and no layout. Every element computes the same colours there, so axe's
 * `color-contrast` rule cannot reach a verdict and is switched off explicitly in `a11y.tsx`. The
 * brief requires contrast to be checked, and contrast is a property of the *rendered* page — the
 * platform's palette applied through the compiled stylesheet. Only a browser has both.
 *
 * ## Why the markup is server-rendered rather than driven through the app
 *
 * Screenshotting the running application would need the API, a database, a session and a tenant —
 * four things that make a UI test fail for reasons that are not about the UI. Rendering a screen to
 * static markup and pairing it with the real built stylesheet gives the same pixels for the parts
 * this phase is responsible for, and fails only when the markup or the styling changes.
 *
 * The cost is stated rather than glossed: **this is a static render.** No hydration, so no dialogue
 * is opened, no dropdown expanded, no focus moved. Interaction is covered by the jsdom suites,
 * which do hydrate. Neither harness covers everything; together they cover more than either.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = dirname(dirname(HERE));
const BASELINES = join(HERE, '__screenshots__');

/** Chromium is pre-installed in this environment at a build playwright does not expect. */
const EXECUTABLE_PATH =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Differences below this are antialiasing, not a regression.
 *
 * Set as a *count of pixels* rather than a percentage: a percentage of a large screenshot hides a
 * small but total change to a small component, which is the regression most worth catching.
 */
const PIXEL_TOLERANCE = 120;

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  browser ??= await chromium.launch({
    headless: true,
    ...(existsSync(EXECUTABLE_PATH) ? { executablePath: EXECUTABLE_PATH } : {}),
  });
  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

/** The application's real compiled stylesheet — the one `verify:styles` checks. */
export function builtStylesheet(): string {
  const dir = join(WEB, '.next/static/css');
  if (!existsSync(dir)) {
    throw new Error(
      'No built stylesheet. Run `pnpm --filter @edms/web build` before the browser suites — ' +
        'they check the CSS that ships, not a re-compilation of it.',
    );
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

export type Theme = 'light' | 'dark';

/**
 * Put server-rendered markup on a page, with the real stylesheet and the theme applied.
 *
 * `dir` and `lang` are set because several of the platform's rules are logical (`border-s`,
 * `padding-s`) and a page with no direction resolves them against a default that is not what
 * either locale gets.
 *
 * `locale` drives both — Phase 7.4C. Until Arabic plural forms existed there was nothing to look at
 * in RTL that was not already covered by the LTR baselines; now the wording itself changes with the
 * count, and a counter that reads correctly in a unit test can still land badly in a badge.
 */
export async function renderPage(
  html: string,
  {
    theme = 'light',
    width = 1280,
    height = 900,
    locale = 'en',
  }: { theme?: Theme; width?: number; height?: number; locale?: 'en' | 'ar' } = {},
): Promise<Page> {
  const page = await (await getBrowser()).newPage({ viewport: { width, height } });
  await page.setContent(
    `<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}" ` +
      `class="${theme === 'dark' ? 'dark' : ''}">` +
      `<head><meta charset="utf-8"><style>${builtStylesheet()}</style></head>` +
      `<body class="bg-background text-foreground">${html}</body></html>`,
    { waitUntil: 'load' },
  );
  return page;
}

export interface ContrastViolation {
  readonly id: string;
  readonly impact: string;
  readonly help: string;
  readonly nodes: readonly { readonly html: string; readonly summary: string }[];
}

/** Run axe in the page, with contrast on — the rule jsdom cannot answer. */
export async function contrastViolations(page: Page): Promise<ContrastViolation[]> {
  const axeSource = readFileSync(join(WEB, 'node_modules/axe-core/axe.min.js'), 'utf8');
  await page.addScriptTag({ content: axeSource });

  return page.evaluate(async () => {
    const results = await (
      globalThis as unknown as {
        axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: unknown[] }> };
      }
    ).axe.run(document.body, {
      runOnly: { type: 'rule', values: ['color-contrast'] },
    });
    return results.violations.map((violation) => {
      const v = violation as {
        id: string;
        impact: string | null;
        help: string;
        nodes: { html: string; failureSummary?: string }[];
      };
      return {
        id: v.id,
        impact: v.impact ?? 'unknown',
        help: v.help,
        nodes: v.nodes.map((node) => ({
          html: node.html.slice(0, 200),
          summary: node.failureSummary ?? '',
        })),
      };
    });
  });
}

export interface ScreenshotResult {
  readonly created: boolean;
  readonly changedPixels: number;
  readonly diffPath?: string;
}

/**
 * Compare a screenshot against its baseline, writing one if none exists.
 *
 * A missing baseline is *created* rather than failed, so adding a screen is one commit rather than
 * two. What that costs is that a first run always passes — which is why the report says how many
 * baselines exist, and why the count is the thing to watch rather than the pass.
 */
export async function matchesBaseline(page: Page, name: string): Promise<ScreenshotResult> {
  mkdirSync(BASELINES, { recursive: true });
  const baselinePath = join(BASELINES, `${name}.png`);
  const actual = await page.screenshot({ fullPage: true });

  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, actual);
    return { created: true, changedPixels: 0 };
  }

  const expected = PNG.sync.read(readFileSync(baselinePath));
  const current = PNG.sync.read(actual);

  if (expected.width !== current.width || expected.height !== current.height) {
    const diffPath = join(BASELINES, `${name}.actual.png`);
    writeFileSync(diffPath, actual);
    throw new Error(
      `${name}: size changed — baseline ${String(expected.width)}×${String(expected.height)}, ` +
        `now ${String(current.width)}×${String(current.height)}. Wrote ${diffPath}.`,
    );
  }

  const diff = new PNG({ width: expected.width, height: expected.height });
  const changedPixels = pixelmatch(
    expected.data,
    current.data,
    diff.data,
    expected.width,
    expected.height,
    { threshold: 0.15 },
  );

  if (changedPixels > PIXEL_TOLERANCE) {
    const diffPath = join(BASELINES, `${name}.diff.png`);
    writeFileSync(diffPath, PNG.sync.write(diff));
    writeFileSync(join(BASELINES, `${name}.actual.png`), actual);
    return { created: false, changedPixels, diffPath };
  }

  return { created: false, changedPixels };
}
