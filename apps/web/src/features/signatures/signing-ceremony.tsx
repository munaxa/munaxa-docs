'use client';

import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';

import { Alert, Button, Dialog, Field, Input, Select, Textarea } from '@munaxa/ui';

import type { SignatureStatementPreview } from '@edms/contracts';
import { ALL_SIGNATURE_PURPOSES, ErrorCode, type SignaturePurposeKey } from '@edms/domain';

import { useTranslate } from '../../app/providers';
import type { ActionResult } from '../../lib/admin/action-result';
import { previewStatement, signRevision } from './actions';

/** The real translator's type, so a helper cannot be handed a looser one. */
type Translate = ReturnType<typeof useTranslate>;

/** A failed `ActionResult`, which is the only half of one this screen ever holds. */
type Refusal = Extract<ActionResult<unknown>, { ok: false }>;

/**
 * One credential field, read out of the submission.
 *
 * Narrowed rather than stringified: `FormData.get` can answer a `File`, and coercing one would put
 * `[object File]` into a password. There is no file input in this form, so the branch is
 * unreachable — which is exactly why it returns the empty string rather than pretending.
 */
function fieldValue(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * The signing ceremony — Phase 6.6, and the one screen in this product that is a regulatory
 * instrument rather than a form.
 *
 * ## The shape, and why the first click does not sign
 *
 * 21 CFR Part 11 §11.50 makes the *manifestation* the evidence: the printed name, the instant and
 * the stated meaning have to be shown to the person who is attesting them. So `Sign` opens this,
 * and this asks the server what the statement says before it asks anybody to agree to it.
 *
 *   idle → loadingStatement → statementReady → confirming → signing → success
 *                                    ↕                         ↓
 *                                   error ←───────────────────┘
 *
 * Local state, deliberately. A global machine for one dialogue would put a half-finished
 * attestation into application state, which is the last thing that should survive a navigation.
 *
 * ## Where re-authentication sits, and why it is not its own stage
 *
 * The brief's sequence puts re-authentication before a final confirmation. **There is no
 * re-authentication endpoint**, and that is a deliberate property of the design rather than a gap:
 * `SignerAuthenticator` is an internal port, and credentials are proved only by the act that
 * consumes them. A standalone "check my password" call would be exactly the credential oracle
 * ADR-0017 §6's single undifferentiated refusal exists to prevent, and building one would be
 * inventing backend capability this phase is told not to invent.
 *
 * So the confirmation stage carries the credentials *and* the explicit confirmation, and one
 * deliberate submit performs both. What the brief actually asks for is preserved:
 *
 * - the statement is read before credentials are ever shown — `statementReady` is a stage of its own
 *   with no password field on it;
 * - nothing signs automatically after a credential succeeds, because there is no credential-success
 *   event to follow: the checkbox must be ticked and the button pressed;
 * - the confirmation names the document, the revision and the meaning, in words.
 *
 * ## Where the credentials live
 *
 * Nowhere. The password and the code are uncontrolled inputs inside a `<form>`; they are read out of
 * `FormData` at submit, handed to a server action, and the dialogue unmounts. **They are never in
 * React state, never in a ref, never in a URL, never in storage and never in a log line.** The
 * sign-in form does the same thing for the same reason, and this follows it rather than inventing a
 * second way to hold a secret.
 *
 * ## What the browser never does
 *
 * It does not build, parse, translate, normalise, digest or verify the statement. `statementBody`
 * arrives from the server and is rendered as text. ADR-0017 §3 stores those bytes verbatim so that
 * nothing ever has to reproduce them, and a browser that reproduced them would be displaying a
 * different artefact from the one being signed.
 */

export type CeremonyStage =
  'loadingStatement' | 'statementReady' | 'confirming' | 'signing' | 'success' | 'error';

export function SigningCeremony({
  documentId,
  documentTitle,
  revisionId,
  revisionLabel,
  mfaEnrolled,
  onClose,
  onSigned,
}: {
  readonly documentId: string;
  readonly documentTitle: string;
  readonly revisionId: string;
  readonly revisionLabel: string;
  /**
   * Whether *this* person owes a TOTP code, from `GET /auth/mfa` — their own status and nobody
   * else's. There is no request in this product by which one person could ask about another's
   * factor, which is why the field is rendered from a boolean fetched for the caller rather than
   * guessed from a role or a tenant setting.
   */
  readonly mfaEnrolled: boolean;
  readonly onClose: () => void;
  readonly onSigned: () => void;
}): ReactNode {
  const translate = useTranslate();
  const formId = useId();
  const statementId = useId();

  const [purpose, setPurpose] = useState<SignaturePurposeKey>('APPROVAL');
  const [comment, setComment] = useState('');
  const [stage, setStage] = useState<CeremonyStage>('loadingStatement');
  const [preview, setPreview] = useState<SignatureStatementPreview | null>(null);
  /**
   * The refusal, held as the *result* rather than as a translated sentence.
   *
   * Not a style choice — a defect this suite caught. `useTranslate()` calls `translatorFor`, which
   * returns a new closure on every render, so a translated message would have had to be produced
   * inside the effect and `translate` would have had to be a dependency. That makes the effect run
   * on every render: the statement is re-fetched in a loop and `stage` is reset to
   * `loadingStatement` the instant anything advances it, so Continue never continues. Keeping the
   * result and translating it during render removes the dependency and the loop with it.
   */
  const [problem, setProblem] = useState<Refusal | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  // The statement is re-read whenever what it would say changes. The meaning and the signer's own
  // words are *inside* the attested bytes, so a preview taken before either was chosen would be a
  // preview of a different statement — which is precisely the failure this whole design avoids.
  useEffect(() => {
    let current = true;
    setStage('loadingStatement');
    setProblem(null);
    void previewStatement(documentId, {
      revisionId,
      purpose,
      ...(comment === '' ? {} : { statement: comment }),
    }).then((result) => {
      if (!current) {
        return;
      }
      if (result.ok) {
        setPreview(result.value);
        setStage('statementReady');
        return;
      }
      setPreview(null);
      setProblem(result);
      setStage('error');
    });
    return () => {
      current = false;
    };
  }, [documentId, revisionId, purpose, comment]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setStage('signing');
    setProblem(null);

    // Read here and passed straight on. The values are not assigned to state, and the form is
    // unmounted by the stage change below before anything else could reach them.
    const result = await signRevision(documentId, {
      revisionId,
      purpose,
      ...(comment === '' ? {} : { statement: comment }),
      password: fieldValue(data, 'password'),
      ...(mfaEnrolled ? { mfaCode: fieldValue(data, 'mfaCode') } : {}),
    });

    if (result.ok) {
      setStage('success');
      onSigned();
      return;
    }
    setProblem(result);
    setStage('error');
  }

  const purposeMeaning = translate(`signatures.purpose.${purpose}`);

  return (
    <Dialog
      open
      onClose={() => {
        // A signing request in flight is not interruptible from here: the API is the only party
        // that knows whether it committed, and closing mid-request would leave the screen asserting
        // something it does not know. Every other stage closes freely and signs nothing.
        if (stage !== 'signing') {
          onClose();
        }
      }}
      title={translate('signatures.ceremony.title')}
      description={`${documentTitle} · ${translate('signatures.ceremony.revisionLabel')} ${revisionLabel}`}
      className="max-w-2xl"
      footer={footerFor({
        stage,
        formId,
        acknowledged,
        translate,
        onClose,
        onContinue: () => {
          setStage('confirming');
        },
        onBack: () => {
          setAcknowledged(false);
          setStage('statementReady');
        },
      })}
    >
      <div className="flex flex-col gap-4">
        {problem === null ? null : (
          <Alert tone="danger" live="alert">
            {messageFor(problem, translate)}
          </Alert>
        )}

        {(stage === 'loadingStatement' ||
          stage === 'statementReady' ||
          (stage === 'error' && preview === null)) && (
          <StatementStage
            statementId={statementId}
            stage={stage}
            preview={preview}
            purpose={purpose}
            comment={comment}
            onPurpose={setPurpose}
            onComment={setComment}
          />
        )}

        {(stage === 'confirming' ||
          stage === 'signing' ||
          (stage === 'error' && preview !== null)) && (
          <form
            id={formId}
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              void submit(event);
            }}
          >
            <h3 className="text-base font-medium">
              {translate('signatures.ceremony.confirmHeading')}
            </h3>
            <p className="text-sm">
              {translate('signatures.ceremony.confirmIntro', {
                document: documentTitle,
                revision: revisionLabel,
                purpose: purposeMeaning,
              })}
            </p>

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="acknowledged"
                checked={acknowledged}
                onChange={(event) => {
                  setAcknowledged(event.currentTarget.checked);
                }}
                disabled={stage === 'signing'}
                required
              />
              <span>{translate('signatures.ceremony.confirmCheckbox')}</span>
            </label>

            <p className="text-sm opacity-70">{translate('signatures.ceremony.credentialsHint')}</p>

            <Field
              label={translate('signatures.field.password')}
              hint={translate('signatures.field.passwordHint')}
              required
            >
              <Input
                name="password"
                type="password"
                autoComplete="current-password"
                disabled={stage === 'signing'}
                required
                autoFocus
              />
            </Field>

            {mfaEnrolled && (
              <Field label={translate('signatures.field.mfaCode')} required>
                <Input
                  name="mfaCode"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  spellCheck={false}
                  disabled={stage === 'signing'}
                  required
                />
              </Field>
            )}
          </form>
        )}

        {stage === 'success' && (
          <Alert tone="success" live="status">
            {translate('signatures.ceremony.successBody', { revision: revisionLabel })}
          </Alert>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The statement, and the two choices that are inside it.
 *
 * The meaning and the comment sit *above* the statement rather than below it, because changing
 * either changes the bytes: a reader who chose a meaning after reading would have read a statement
 * that is no longer the one they would sign.
 */
function StatementStage({
  statementId,
  stage,
  preview,
  purpose,
  comment,
  onPurpose,
  onComment,
}: {
  readonly statementId: string;
  readonly stage: CeremonyStage;
  readonly preview: SignatureStatementPreview | null;
  readonly purpose: SignaturePurposeKey;
  readonly comment: string;
  readonly onPurpose: (value: SignaturePurposeKey) => void;
  readonly onComment: (value: string) => void;
}): ReactNode {
  const translate = useTranslate();

  return (
    <>
      <Field
        label={translate('signatures.field.purpose')}
        hint={translate('signatures.ceremony.purposeHint')}
        required
      >
        <Select
          value={purpose}
          onChange={(event) => {
            onPurpose(event.currentTarget.value as SignaturePurposeKey);
          }}
        >
          {ALL_SIGNATURE_PURPOSES.map((value) => (
            <option key={value} value={value}>
              {translate(`signatures.purpose.${value}`)}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label={translate('signatures.field.statement')}
        hint={translate('signatures.ceremony.commentHint')}
      >
        <Textarea
          value={comment}
          rows={2}
          maxLength={2000}
          onChange={(event) => {
            onComment(event.currentTarget.value);
          }}
        />
      </Field>

      <section aria-labelledby={statementId} className="flex flex-col gap-2">
        <h3 id={statementId} className="text-base font-medium">
          {translate('signatures.ceremony.statementHeading')}
        </h3>
        <p className="text-sm opacity-70">{translate('signatures.ceremony.statementHint')}</p>

        {stage === 'loadingStatement' || preview === null ? (
          <p className="text-sm opacity-70" role="status">
            {translate('signatures.ceremony.loadingStatement')}
          </p>
        ) : (
          <>
            {/*
              Rendered verbatim, scrollable rather than truncated, and reachable by keyboard.
              `tabIndex={0}` is what makes a scroll container operable without a mouse — a region a
              keyboard user cannot scroll is a statement they cannot finish reading, which would
              make the manifestation worse than useless. `whitespace-pre-wrap` preserves the line
              structure the server produced; nothing here reformats it.
            */}
            <pre
              data-testid="signature-statement"
              tabIndex={0}
              className="max-h-64 overflow-auto whitespace-pre-wrap rounded border p-3 font-mono text-xs"
              dir="ltr"
            >
              {preview.statementBody}
            </pre>
            <p className="text-sm opacity-70">
              {translate('signatures.ceremony.preparedAt', {
                date: new Date(preview.preparedAt).toLocaleString(),
              })}
            </p>
          </>
        )}
      </section>
    </>
  );
}

function footerFor({
  stage,
  formId,
  acknowledged,
  translate,
  onClose,
  onContinue,
  onBack,
}: {
  readonly stage: CeremonyStage;
  readonly formId: string;
  readonly acknowledged: boolean;
  readonly translate: Translate;
  readonly onClose: () => void;
  readonly onContinue: () => void;
  readonly onBack: () => void;
}): ReactNode {
  if (stage === 'success') {
    return (
      <Button type="button" onClick={onClose}>
        {translate('signatures.ceremony.done')}
      </Button>
    );
  }

  const onStatement = stage === 'loadingStatement' || stage === 'statementReady';
  return (
    <>
      <Button type="button" variant="outline" disabled={stage === 'signing'} onClick={onClose}>
        {translate('signatures.ceremony.cancel')}
      </Button>
      {!onStatement && (
        <Button type="button" variant="ghost" disabled={stage === 'signing'} onClick={onBack}>
          {translate('signatures.ceremony.back')}
        </Button>
      )}
      {onStatement ? (
        <Button type="button" disabled={stage !== 'statementReady'} onClick={onContinue}>
          {translate('signatures.ceremony.continue')}
        </Button>
      ) : (
        // Disabled until the statement has been acknowledged: the checkbox is the explicit act,
        // and `required` on it would only be enforced at submit — too late to communicate anything.
        <Button type="submit" form={formId} disabled={stage === 'signing' || !acknowledged}>
          {stage === 'signing'
            ? translate('signatures.ceremony.signing')
            : translate('signatures.ceremony.submit')}
        </Button>
      )}
    </>
  );
}

/**
 * One sentence per refusal, from the code rather than from the server's prose.
 *
 * `FORBIDDEN` is the §11.200 refusal and is deliberately the same sentence sign-in gives: the API
 * answers one undifferentiated refusal for a wrong password, a missing code and a wrong code alike,
 * and a screen that guessed which would undo that on the client. `RATE_LIMITED` says to wait
 * without naming a limiter, a counter, a cache or a number the server did not send.
 */
function messageFor(result: Refusal, translate: Translate): string {
  switch (result.code) {
    case ErrorCode.VALIDATION_FAILED:
      // The one code where the server knows something the client's schema did not catch — a
      // duplicate signature, a discarded revision — and its own sentence is the useful one.
      return result.detail ?? translate('signatures.errors.conflict');
    case ErrorCode.RATE_LIMITED:
      return translate('signatures.errors.rateLimited');
    default:
      return translate(`error.${result.code}`);
  }
}
