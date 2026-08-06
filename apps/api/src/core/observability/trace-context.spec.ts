import { describe, expect, it } from 'vitest';

import {
  continueOrStartTrace,
  formatTraceparent,
  newSpanId,
  newTraceId,
  parseTraceparent,
  startTrace,
} from './trace-context';

const VALID = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('W3C trace context', () => {
  it('reads a well-formed header and keeps the caller’s trace id', () => {
    const context = parseTraceparent(VALID);

    expect(context?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(context?.parentSpanId).toBe('00f067aa0ba902b7');
    expect(context?.sampled).toBe(true);
  });

  it('gives the request its own span rather than reusing the caller’s', () => {
    // The failure this prevents is two services reporting the same span id, which a collector
    // renders as one span that impossibly spans both processes.
    const context = parseTraceparent(VALID);

    expect(context?.spanId).not.toBe('00f067aa0ba902b7');
    expect(context?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('honours the sampled bit rather than re-deciding it', () => {
    expect(parseTraceparent(VALID.replace(/-01$/, '-00'))?.sampled).toBe(false);
  });

  it('reads the sampled bit as a bit, not as a byte comparison', () => {
    // The other seven flag bits are reserved and a future caller may set one. `03` is sampled.
    expect(parseTraceparent(VALID.replace(/-01$/, '-03'))?.sampled).toBe(true);
    expect(parseTraceparent(VALID.replace(/-01$/, '-02'))?.sampled).toBe(false);
  });

  it.each([
    ['nothing at all', undefined],
    ['empty', ''],
    ['a future version', '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['a short trace id', '00-4bf92f3577b34da6-00f067aa0ba902b7-01'],
    ['a short span id', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa-01'],
    ['non-hex', '00-zzf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'],
    ['a header with an injected newline', `${VALID}\nx-evil: 1`],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`],
    ['an all-zero span id', `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`],
  ])('refuses %s', (_case, header) => {
    expect(parseTraceparent(header)).toBeNull();
  });

  it('starts a fresh trace when the header is unusable, rather than propagating rubbish', () => {
    const context = continueOrStartTrace('nonsense');

    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(context.parentSpanId).toBeNull();
  });

  it('round-trips: what it emits, it can read', () => {
    const started = startTrace();
    const received = parseTraceparent(formatTraceparent(started));

    expect(received?.traceId).toBe(started.traceId);
    expect(received?.parentSpanId).toBe(started.spanId);
  });

  it('emits this span as the parent, so a receiver nests under this request', () => {
    expect(formatTraceparent(startTrace())).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('generates identifiers of the specified widths', () => {
    expect(newTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newTraceId()).not.toBe(newTraceId());
  });
});
