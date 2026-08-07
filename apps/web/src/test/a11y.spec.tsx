import { describe, expect, it } from 'vitest';

import { expectNoViolations, renderWithProviders } from './a11y';

/**
 * The harness's own test — the guard's guard.
 *
 * Phase 5.1 shipped a stylesheet checker whose first draft passed against a deliberately broken
 * build, and the lesson generalises: **a check that fails open converts an absent test into a false
 * assurance**, which is worse than having no test. Every screen suite in this repository passed axe
 * on its first run, and that is only good news if axe would have said otherwise.
 *
 * So each failure class the Phase 5.2 brief names is seeded here and asserted to be caught. If a
 * future axe upgrade, rule change or harness edit silently stops detecting one, this fails rather
 * than the screens quietly going green.
 */

async function violations(markup: React.ReactElement): Promise<string> {
  const container = renderWithProviders(markup);
  try {
    await expectNoViolations(container);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('the accessibility harness catches', () => {
  it('a control with no label', async () => {
    const message = await violations(
      <form>
        <input type="text" name="unlabelled" />
      </form>,
    );
    expect(message).toContain('label');
  });

  it('a link with no discernible text', async () => {
    const message = await violations(<a href="/somewhere" />);
    expect(message).toContain('link-name');
  });

  it('a button with no accessible name', async () => {
    const message = await violations(<button type="button" />);
    expect(message).toContain('button-name');
  });

  it('invalid ARIA', async () => {
    const message = await violations(
      <div role="button" aria-invalidattribute="yes" tabIndex={0} />,
    );
    expect(message).toContain('aria');
  });

  it('an aria-labelledby pointing at nothing', async () => {
    const message = await violations(
      <form>
        <input type="text" aria-labelledby="does-not-exist" />
      </form>,
    );
    expect(message).toContain('aria');
  });

  it('a duplicate id — a rule axe ships switched off', async () => {
    const message = await violations(
      <div>
        <input id="twice" aria-label="First" />
        <input id="twice" aria-label="Second" />
      </div>,
    );
    expect(message).toMatch(/duplicate-id|id-unique|attributes/i);
  });

  it('an image with no alternative text', async () => {
    const message = await violations(<img src="/logo.png" />);
    expect(message).toContain('image-alt');
  });

  it('a data cell whose row has headers it does not reference', async () => {
    // `td-has-header` applies only to tables larger than 3×3, and only once the table is
    // recognisable as a data table — a table with no `th` at all is indistinguishable from a
    // layout table, so axe declines to guess rather than reporting a false positive. Hence a
    // column header on the first column only.
    const rows = [0, 1, 2, 3];
    const message = await violations(
      <table>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              <th scope="row">{`r${String(row)}`}</th>
              {rows.map((cell) => (
                <td key={cell} headers="missing-header-id">{`r${String(row)}c${String(cell)}`}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>,
    );
    expect(message).toContain('td-headers-attr');
  });

  it('and passes markup that is actually correct', async () => {
    // The other half of the proof: a harness that failed everything would also pass every test
    // above while being useless.
    const message = await violations(
      <main>
        <h1>Title</h1>
        <form>
          <label htmlFor="named">Name</label>
          <input id="named" type="text" />
        </form>
      </main>,
    );
    expect(message).toBe('');
  });
});

describe('the harness records what it cannot check', () => {
  it('has colour contrast switched off, because jsdom has no cascade', async () => {
    // Not an accident and not a suppression of a real finding: jsdom computes the same colours for
    // every element, so the rule cannot reach a verdict here. It is checked in a real browser.
    // This test exists so that "contrast is covered" is never assumed from a green run.
    const message = await violations(
      <p style={{ color: '#fafafa', background: '#ffffff' }}>Invisible text</p>,
    );
    expect(message).toBe('');
  });
});
