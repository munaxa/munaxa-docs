import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentSignature } from '@edms/contracts';

import { succeeded } from '../../lib/admin/action-result';
import { expectNoViolations, renderWithProviders } from '../../test/a11y';
import { document, signature } from '../../test/fixtures';
import { SignaturePanel } from './signature-panel';

/**
 * The signing ceremony, rendered — Phase 6.6.
 *
 * ## What this suite is for, and what it deliberately leaves to the browser suite
 *
 * The end-to-end proof — a real API, a real signature, a real audit row — is
 * `apps/web/src/test/signing-e2e.spec.ts`, in Chromium against a booted server. What only a
 * rendered tree can check cheaply, on every push, is the *shape* of the ceremony: that the first
 * click does not sign, that credentials do not appear until the statement has been read, that the
 * server's bytes are rendered verbatim, that Cancel calls nothing, and that axe finds no violation
 * at any stage.
 *
 * The server actions are the mocked boundary and nothing else is. Mocking them is what makes
 * "Cancel signed nothing" assertable as *the sign action was never called*, which is a stronger
 * statement than "no signature appeared".
 *
 * ## Why the statement is asserted as an exact string
 *
 * Because the one thing this screen must never do is reproduce it. The mock returns bytes with a
 * shape no component could have composed — a version marker, colon-delimited fields, a trailing
 * newline — and the test asserts the rendered text *is* that string. A screen that reformatted,
 * translated or re-serialised it would fail here rather than in front of an inspector.
 */

const STATEMENT_BODY =
  'munaxa-docs-signature/v1\n' +
  'tenant:019489f0-0000-7000-8000-0000000000a1\n' +
  'document:019489f0-0000-7000-8000-000000000101\n' +
  'number:QM-0001\n' +
  'revision:019489f0-0000-7000-8000-000000000401\n' +
  'label:Rev 0\n' +
  `content-sha256:${'a'.repeat(64)}\n` +
  'signer:test-user\n' +
  'signer-name:Ada Lovelace\n' +
  'signer-email:ada@example.test\n' +
  'purpose:APPROVAL\n' +
  'statement:\n' +
  'signed-at:2026-02-01T09:30:00.000Z\n';

const previewStatement = vi.fn();
const signRevision = vi.fn();
const fetchSignatures = vi.fn();
const verifySignature = vi.fn();
const withdrawSignature = vi.fn();

vi.mock('./actions', () => ({
  previewStatement: (...args: unknown[]) => previewStatement(...args) as unknown,
  signRevision: (...args: unknown[]) => signRevision(...args) as unknown,
  fetchSignatures: (...args: unknown[]) => fetchSignatures(...args) as unknown,
  verifySignature: (...args: unknown[]) => verifySignature(...args) as unknown,
  withdrawSignature: (...args: unknown[]) => withdrawSignature(...args) as unknown,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

beforeEach(() => {
  previewStatement.mockResolvedValue(
    succeeded({
      revisionId: '019489f0-0000-7000-8000-000000000401',
      purpose: 'APPROVAL',
      statementBody: STATEMENT_BODY,
      preparedAt: '2026-02-01T09:29:00.000Z',
    }),
  );
  signRevision.mockResolvedValue(succeeded(signature()));
  fetchSignatures.mockResolvedValue(succeeded([signature()]));
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Rendered inside a `<main>`, because that is where it lives.
 *
 * Not a way of quieting axe's `region` rule — a way of not lying to it. `SignaturePanel` is a slot
 * on `DocumentScreen`, which renders inside `WorkspaceShell`'s main landmark; a bare render would
 * ask axe about a page this product never serves, and the violation it reported would be about the
 * test rather than about the panel.
 */
function renderPanel(
  options: {
    canSign?: boolean;
    mfaEnrolled?: boolean | null;
    signatures?: readonly DocumentSignature[] | null;
  } = {},
): void {
  renderWithProviders(
    <main>
      <SignaturePanel
        document={document()}
        signatures={options.signatures === undefined ? [] : options.signatures}
        canSign={options.canSign ?? true}
        mfaEnrolled={options.mfaEnrolled === undefined ? false : options.mfaEnrolled}
      />
    </main>,
  );
}

async function openCeremony(options: { mfaEnrolled?: boolean | null } = {}): Promise<void> {
  const user = userEvent.setup();
  renderPanel(options);
  await user.click(screen.getByRole('button', { name: 'Sign' }));
  await screen.findByTestId('signature-statement');
}

describe('the first click does not sign', () => {
  it('opens a dialogue and requests the statement instead', async () => {
    await openCeremony();

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(previewStatement).toHaveBeenCalledTimes(1);
    // The whole point of the ceremony. Nothing has been signed by opening it.
    expect(signRevision).not.toHaveBeenCalled();
  });

  it('asks for no credentials until the statement has been read', async () => {
    await openCeremony();

    // There is no password field on the statement stage, which is what makes "read before you
    // attest" a property of the markup rather than of the copy.
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });
});

describe('the statement', () => {
  it('renders the server bytes verbatim', async () => {
    await openCeremony();

    // Exact equality, not "contains": a screen that rebuilt, reordered, translated or reflowed the
    // statement would display a different artefact from the one the signature attests.
    expect(screen.getByTestId('signature-statement').textContent).toBe(STATEMENT_BODY);
  });

  it('is scrollable and reachable by keyboard rather than truncated', async () => {
    await openCeremony();

    const statement = screen.getByTestId('signature-statement');
    // A scroll container a keyboard user cannot focus is a statement they cannot finish reading.
    expect(statement.getAttribute('tabindex')).toBe('0');
    expect(statement.className).toContain('overflow-auto');
  });

  it('says the prepared instant is not the signing instant', async () => {
    await openCeremony();

    expect(screen.getByText(/carries the moment you confirm it, not this one/i)).toBeTruthy();
  });

  it('is re-read when the meaning changes, because the meaning is inside it', async () => {
    const user = userEvent.setup();
    await openCeremony();
    previewStatement.mockClear();

    await user.selectOptions(screen.getByLabelText(/I am signing as/i), 'AUTHORSHIP');

    await waitFor(() => {
      expect(previewStatement).toHaveBeenCalled();
    });
    expect(previewStatement.mock.calls[0]?.[1]).toMatchObject({ purpose: 'AUTHORSHIP' });
  });
});

describe('confirmation', () => {
  it('cannot be submitted until the acknowledgement is ticked', async () => {
    const user = userEvent.setup();
    await openCeremony();

    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const submit = screen.getByRole('button', { name: 'Sign this revision' });
    expect(submit.hasAttribute('disabled')).toBe(true);

    await user.click(screen.getByRole('checkbox'));
    expect(submit.hasAttribute('disabled')).toBe(false);
    // Still nothing signed: enabling a button is not performing an act.
    expect(signRevision).not.toHaveBeenCalled();
  });

  it('names the document, the revision and the meaning', async () => {
    const user = userEvent.setup();
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // The confirmation's own sentence, not the dialogue's subtitle — both name the document, and
    // the one under test is the one that says what is about to happen.
    const intro = within(screen.getByRole('dialog')).getByText(
      /You are about to create an electronic signature/,
    );
    expect(intro.textContent ?? '').toContain('Quality Manual');
    expect(intro.textContent ?? '').toContain('Rev 0');
    expect(intro.textContent ?? '').toContain('Approving this for release');
  });

  it('asks for no code when this person has no factor', async () => {
    const user = userEvent.setup();
    await openCeremony({ mfaEnrolled: false });
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.queryByLabelText(/Authenticator code/i)).toBeNull();
  });

  it('asks for a code when this person has one', async () => {
    const user = userEvent.setup();
    await openCeremony({ mfaEnrolled: true });
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    // From `GET /auth/mfa`, which answers for the caller alone. Nothing here can be asked about
    // somebody else's factor, which is what stops the ceremony becoming an enrolment oracle.
    expect(screen.getByLabelText(/Authenticator code/i)).toBeTruthy();
  });

  it('asks for a code, optionally, when nobody could find out — Slice 27', async () => {
    /*
     * The defect this closes. `GET /auth/mfa` is swallowed on the record page, and that swallow
     * used to be `{ enrolled: false }` — so an enrolled signer got *this* ceremony with no code
     * field, submitted a correct password, and was refused with `sign without proving your
     * credentials`: one message covering a wrong password too, and no field to put the code in.
     *
     * The field is offered for `null` and not required, because the signer may owe no code at all.
     * The server stays the authority either way.
     */
    const user = userEvent.setup();
    await openCeremony({ mfaEnrolled: null });
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const field = screen.getByLabelText(/Authenticator code/i);
    expect(field).toBeTruthy();
    expect((field as HTMLInputElement).required).toBe(false);
    expect(
      screen.getByText(/could not check whether your account uses an authenticator/i),
    ).toBeTruthy();
  });

  it('still requires the code when the factor is known to exist', async () => {
    // The half that must not have loosened: a known-enrolled signer is still made to prove it.
    const user = userEvent.setup();
    await openCeremony({ mfaEnrolled: true });
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect((screen.getByLabelText(/Authenticator code/i) as HTMLInputElement).required).toBe(true);
  });

  it('sends the code an unknown-status signer typed', async () => {
    const user = userEvent.setup();
    await openCeremony({ mfaEnrolled: null });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText(/Your password/i), 'correct horse battery staple');
    await user.type(screen.getByLabelText(/Authenticator code/i), '123456');
    await user.click(screen.getByRole('button', { name: 'Sign this revision' }));

    await waitFor(() => {
      expect(signRevision).toHaveBeenCalledTimes(1);
    });
    expect(signRevision.mock.calls[0]?.[1]).toMatchObject({ mfaCode: '123456' });
  });

  it('omits the code rather than sending an empty one', async () => {
    /*
     * `signRevisionSchema` bounds `mfaCode` at `min(6)`, so an unenrolled signer who was shown the
     * optional field and left it blank would have been refused by validation — trading one dead end
     * for another. Absent means absent.
     */
    const user = userEvent.setup();
    await openCeremony({ mfaEnrolled: null });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText(/Your password/i), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign this revision' }));

    await waitFor(() => {
      expect(signRevision).toHaveBeenCalledTimes(1);
    });
    expect(signRevision.mock.calls[0]?.[1]).not.toHaveProperty('mfaCode');
  });

  it('signs once the credentials and the acknowledgement are given', async () => {
    const user = userEvent.setup();
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText(/Your password/i), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign this revision' }));

    await waitFor(() => {
      expect(signRevision).toHaveBeenCalledTimes(1);
    });
    expect(signRevision.mock.calls[0]?.[1]).toMatchObject({
      revisionId: '019489f0-0000-7000-8000-000000000401',
      purpose: 'APPROVAL',
      password: 'correct horse battery staple',
    });
  });

  it('reads the signed state back from the API rather than assuming it', async () => {
    const user = userEvent.setup();
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText(/Your password/i), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign this revision' }));

    // The list is refetched. An optimistic row would look identical on screen and be wrong after a
    // reload, which is exactly the failure mode a signed state must not have.
    await waitFor(() => {
      expect(fetchSignatures).toHaveBeenCalled();
    });
  });
});

describe('cancelling', () => {
  it('signs nothing from the statement stage', async () => {
    const user = userEvent.setup();
    await openCeremony();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(signRevision).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('signs nothing from the confirmation stage, credentials typed or not', async () => {
    const user = userEvent.setup();
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText(/Your password/i), 'correct horse battery staple');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(signRevision).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('goes back to the statement without signing', async () => {
    const user = userEvent.setup();
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Back to the statement' }));

    expect(screen.getByTestId('signature-statement')).toBeTruthy();
    expect(signRevision).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('shows the server’s sentence for a duplicate and signs nothing more', async () => {
    const user = userEvent.setup();
    signRevision.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      detail: 'You have already signed this revision for that purpose.',
    });
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText(/Your password/i), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign this revision' }));

    expect((await screen.findByRole('alert')).textContent ?? '').toMatch(
      /already signed this revision/,
    );
  });

  it('says to wait when rate limited, and names no infrastructure', async () => {
    const user = userEvent.setup();
    signRevision.mockResolvedValue({ ok: false, code: 'RATE_LIMITED', detail: null });
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText(/Your password/i), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign this revision' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toMatch(/Too many signing attempts/);
    // No counter, no window, no cache, no connection. A refusal tells a caller what to do, not
    // what the infrastructure is doing.
    expect(alert.textContent ?? '').not.toMatch(/redis|cache|counter|bucket|ECONNREFUSED/i);
  });

  it('gives the same sentence for every credential failure', async () => {
    const user = userEvent.setup();
    signRevision.mockResolvedValue({ ok: false, code: 'FORBIDDEN', detail: null });
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('checkbox'));
    await user.type(screen.getByLabelText(/Your password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign this revision' }));

    // One refusal for every cause, matching the API. A screen that distinguished "wrong password"
    // from "code required" would undo on the client what ADR-0017 §6 protects on the server.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').not.toMatch(/password|code|factor/i);
  });

  it('leaves the ceremony on the statement when the preview itself is refused', async () => {
    previewStatement.mockResolvedValue({
      ok: false,
      code: 'VALIDATION_FAILED',
      detail: 'A discarded revision cannot be signed.',
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Sign' }));

    expect((await screen.findByRole('alert')).textContent ?? '').toMatch(/discarded revision/);
    // No statement to read means nothing to attest, so the confirmation is never offered.
    expect(screen.queryByLabelText(/Your password/i)).toBeNull();
  });
});

describe('the signing action is not offered without the permission', () => {
  it('hides it for a reader', () => {
    renderPanel({ canSign: false });

    expect(screen.queryByRole('button', { name: 'Sign' })).toBeNull();
    // A courtesy, not a control: `document:sign` and `@ScopedTo` are re-checked on the route, and
    // the preview endpoint is behind the same pair. The API suite is where the refusal is proved.
  });
});

describe('accessibility', () => {
  it('has no violations at the statement stage', async () => {
    await openCeremony();
    await expectNoViolations(window.document.body);
  });

  it('has no violations at the confirmation stage, with a factor', async () => {
    const user = userEvent.setup();
    await openCeremony({ mfaEnrolled: true });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await expectNoViolations(window.document.body);
  });

  it('has no violations on the signed list, verification expanded', async () => {
    const user = userEvent.setup();
    verifySignature.mockResolvedValue(
      succeeded({
        signatureId: signature().id,
        signatureValid: true,
        contentMatches: true,
        withdrawn: false,
        witnessedBy: 'munaxa-docs:0123456789abcdef',
        algorithm: 'HMAC-SHA256',
        statementBody: STATEMENT_BODY,
      }),
    );
    renderWithProviders(
      <main>
        <SignaturePanel
          document={document()}
          signatures={[
            signature(),
            signature({ id: 'b', withdrawnAt: '2026-03-01T00:00:00.000Z' }),
          ]}
          canSign
          mfaEnrolled={false}
        />
      </main>,
    );
    await user.click(screen.getAllByRole('button', { name: 'Verify' })[0] as HTMLElement);
    await screen.findByText(/The signature is intact/);

    await expectNoViolations(window.document.body);
  });
});

/** What the focused control says — read as a plain string so a comparison cannot be narrowed away. */
function labelOfFocus(): string {
  return window.document.activeElement?.textContent ?? '';
}

describe('keyboard', () => {
  it('moves focus into the dialogue and keeps it there', async () => {
    const user = userEvent.setup();
    await openCeremony();

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(window.document.activeElement)).toBe(true);

    // Ten tabs is more than the dialogue holds, so a trap that leaked would have put focus on the
    // page behind by now.
    for (let press = 0; press < 10; press += 1) {
      await user.tab();
      expect(dialog.contains(window.document.activeElement)).toBe(true);
    }
  });

  it('closes on Escape without signing', async () => {
    const user = userEvent.setup();
    await openCeremony();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(signRevision).not.toHaveBeenCalled();
  });

  it('runs the whole ceremony from the keyboard alone', async () => {
    const user = userEvent.setup();
    await openCeremony();

    // Every step from here is a key press. No pointer is used, and the assertion at the end is
    // that a signature request was actually made — not that the controls happen to be focusable.
    await user.tab();
    while (labelOfFocus() !== 'Continue') {
      await user.tab();
    }
    await user.keyboard('{Enter}');

    // The password field takes focus on arrival, so typing lands there without a Tab.
    await screen.findByLabelText(/Your password/i);
    await user.keyboard('correct horse battery staple');
    expect(screen.getByLabelText(/Your password/i)).toHaveProperty(
      'value',
      'correct horse battery staple',
    );

    // The acknowledgement sits above the password in the form, so Shift+Tab reaches it and Space
    // ticks it — Enter would not, which is why the sequence is written out rather than clicked.
    await user.tab({ shift: true });
    expect(window.document.activeElement?.getAttribute('type')).toBe('checkbox');
    await user.keyboard(' ');
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', true);

    // Forward to the submit control and press it.
    //
    // Deliberately Tab-to-the-button rather than Enter-in-the-password-field. The submit button
    // lives in the dialogue's footer and reaches the form by `form=`, which is an HTML feature
    // every browser honours for implicit submission and jsdom does not implement — so asserting
    // Enter-from-a-field here would be asserting a property of the test environment. Tabbing to
    // the control and activating it is what a keyboard user does either way, and it is the path
    // the browser suite exercises against real Chromium.
    let guard = 0;
    while (labelOfFocus() !== 'Sign this revision' && guard < 10) {
      await user.tab();
      guard += 1;
    }
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(signRevision).toHaveBeenCalledTimes(1);
    });
  });
});

describe('sensitive data', () => {
  it('puts no credential in storage or in the URL', async () => {
    const user = userEvent.setup();
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText(/Your password/i), 'correct horse battery staple');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Sign this revision' }));

    await waitFor(() => {
      expect(signRevision).toHaveBeenCalled();
    });

    const stored = JSON.stringify({
      local: { ...window.localStorage },
      session: { ...window.sessionStorage },
      url: window.location.href,
    });
    expect(stored).not.toContain('correct horse battery staple');
  });

  it('unmounts the credential fields once the ceremony succeeds', async () => {
    const user = userEvent.setup();
    await openCeremony();
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.type(screen.getByLabelText(/Your password/i), 'correct horse battery staple');
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Sign this revision' }));

    // The field is gone rather than cleared, which is the stronger property: there is no input
    // holding the value and no state that ever did.
    await waitFor(() => {
      expect(screen.queryByLabelText(/Your password/i)).toBeNull();
    });
    expect(screen.getByText(/Your signature on revision Rev 0 is recorded/)).toBeTruthy();
  });
});

/**
 * What the panel says when it does not know — Slice 25.
 *
 * `documents/[documentId]/page.tsx` reads `GET /documents/:id/signatures` and used to swallow a
 * failure into `[]`. The panel renders `[]` as **"Nobody has signed this revision."**, which is a
 * statement about a controlled document's attestation under ADR-0017 — asserted, on an outage, to
 * a reader with no way to tell. It is the same mistake `documents-read-dependency.md` recorded when
 * a refused permission read rendered `entries: []`, and the same line the layout's unread badge
 * draws when it renders `null` rather than zero.
 *
 * The read now yields `null`, and these two tests are the difference between the two facts.
 */
describe('an unread signature list is not an unsigned revision', () => {
  it('says nobody has signed when the record says so', () => {
    // The positive half first. Without it the assertion below would pass just as well if the panel
    // had stopped rendering either sentence.
    renderPanel({ signatures: [] });

    expect(screen.getByText('Nobody has signed this revision.')).toBeTruthy();
    expect(screen.queryByText('The signatures on this revision could not be read.')).toBeNull();
  });

  it('says it could not read them when the read did not answer', () => {
    renderPanel({ signatures: null });

    expect(screen.getByText('The signatures on this revision could not be read.')).toBeTruthy();
    expect(screen.queryByText('Nobody has signed this revision.')).toBeNull();
  });
});
