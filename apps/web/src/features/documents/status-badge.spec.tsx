import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ALL_DOCUMENT_STATUSES, DocumentStatus } from '@edms/domain';
import { en } from '@edms/i18n';

import { renderWithProviders } from '../../test/a11y';
import { DocumentStatusBadge, statusPresentation } from './status-badge';

/**
 * The status system — Phase 7.
 *
 * Before this component the library rendered `<Badge>{label}</Badge>` for every one of the thirteen
 * lifecycle states, search rendered them all `muted`, and the record page used the default tone. So
 * `PUBLISHED`, `REJECTED` and `EXPIRED` were visually identical and the reader had to read each
 * badge to tell them apart.
 *
 * What is asserted here is the property that stops that returning: **every state the domain defines
 * has a presentation, and none of them relies on colour alone.**
 */
describe('the document status badge', () => {
  it('has a presentation for every state the lifecycle defines', () => {
    // Read from the domain rather than restated, so a state added there fails here rather than
    // rendering with whatever the record's index signature happens to return.
    for (const status of ALL_DOCUMENT_STATUSES) {
      const presentation = statusPresentation(status);
      expect(presentation, `no presentation for ${status}`).toBeDefined();
      // A lucide icon is a `forwardRef` object rather than a plain function, so "is it callable"
      // is the wrong question — that it exists is what matters, and the next test proves it renders.
      expect(presentation.icon, `no icon for ${status}`).toBeTruthy();
    }
  });

  it('never distinguishes a state by colour alone', () => {
    // Five tones for thirteen states, so tone cannot be sufficient even for a reader who sees
    // colour perfectly — `ARCHIVED` and `SUPERSEDED` are both muted. The word and the mark are what
    // separate them, and both must be present.
    for (const status of ALL_DOCUMENT_STATUSES) {
      const container = renderWithProviders(<DocumentStatusBadge status={status} />);
      expect(container.textContent?.trim().length ?? 0, `no label for ${status}`).toBeGreaterThan(
        0,
      );
      expect(container.querySelector('svg'), `no mark for ${status}`).not.toBeNull();
    }
  });

  it('hides the mark from assistive technology, because the word is already there', () => {
    const container = renderWithProviders(
      <DocumentStatusBadge status={DocumentStatus.PUBLISHED} />,
    );
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText(en.documents.status.PUBLISHED)).toBeTruthy();
  });

  it('shows an unrecognised state as its own text rather than failing', () => {
    // The search projection stores the status as denormalised text, so a hit indexed before a state
    // was renamed is a real possibility. Showing the word the index holds is the honest answer;
    // throwing, or guessing a tone, is not.
    const container = renderWithProviders(<DocumentStatusBadge status="SOMETHING_ELSE" />);
    expect(container.textContent).toContain('SOMETHING_ELSE');
  });
});
