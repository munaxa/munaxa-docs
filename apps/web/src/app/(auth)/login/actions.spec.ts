import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the sign-in action sends somebody it has just signed in — RC validation, D-19.
 *
 * The form carries `next` from the URL it was rendered with, so it is attacker-supplied. The action
 * must redirect to it only when it is a path on this origin, and to home otherwise.
 */

const { signIn, redirect } = vi.hoisted(() => ({
  signIn: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('../../../lib/auth', () => ({ signIn }));
vi.mock('next/navigation', () => ({ redirect }));

const { signInAction } = await import('./actions');

function form(next: string): FormData {
  const data = new FormData();
  data.set('email', 'somebody@example.test');
  data.set('password', 'correct horse');
  data.set('tenant', 'acme');
  data.set('next', next);
  return data;
}

beforeEach(() => {
  signIn.mockReset();
  redirect.mockClear();
  signIn.mockResolvedValue({ ok: true });
});

describe('after a successful sign-in', () => {
  it.each([
    ['/', '/'],
    ['/documents', '/documents'],
    [
      '/documents/0197a0b2-7c1e-7d3a-9f00-1234567890ab',
      '/documents/0197a0b2-7c1e-7d3a-9f00-1234567890ab',
    ],
    ['/documents?libraryId=l-1&page=2', '/documents?libraryId=l-1&page=2'],
  ])('returns to the internal destination %s', async (next, expected) => {
    await expect(signInAction({ reason: null }, form(next))).rejects.toThrow(
      `NEXT_REDIRECT ${expected}`,
    );
  });

  it.each([
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'https://evil.example',
    'http://evil.example',
    '///evil.example',
    '/\t/evil.example',
    '/.//evil.example',
    '/%2e%2e//evil.example',
    'javascript:alert(1)',
  ])('goes home rather than to %j', async (next) => {
    await expect(signInAction({ reason: null }, form(next))).rejects.toThrow(/^NEXT_REDIRECT \/$/);
  });

  it('does not redirect anywhere when the sign-in failed', async () => {
    signIn.mockResolvedValue({ ok: false, reason: 'REJECTED' });

    await expect(signInAction({ reason: null }, form('//evil.example'))).resolves.toMatchObject({
      reason: 'REJECTED',
    });
    expect(redirect).not.toHaveBeenCalled();
  });
});
