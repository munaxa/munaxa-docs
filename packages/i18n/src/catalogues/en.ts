/**
 * The English catalogue. It is the reference: every other catalogue is typed against its
 * shape, so a missing or invented Arabic key fails the build rather than rendering a key
 * to a user.
 *
 * Phase 0.5 ships only what the skeleton itself renders — shell states and the error
 * vocabulary. Feature strings arrive with the features.
 */
export const en = {
  app: {
    name: 'Munaxa Docs',
    description: 'Enterprise document control',
  },
  state: {
    loading: 'Loading…',
    empty: 'Nothing here yet',
    emptyHint: 'Items you have access to will appear here.',
    error: 'Something went wrong',
    errorHint: 'The problem has been recorded. Try again, or contact your administrator.',
    retry: 'Try again',
    notFound: 'Page not found',
    notFoundHint: 'The page you asked for does not exist, or you do not have access to it.',
    offline: 'You are offline',
  },
  auth: {
    signIn: 'Sign in',
    signOut: 'Sign out',
    sessionExpired: 'Your session has expired. Sign in again to continue.',
    forbidden: 'You do not have permission to do this.',
    signInHeading: 'Sign in',
    signInSubheading: 'Use your work account to continue.',
    emailLabel: 'Email address',
    passwordLabel: 'Password',
    organisationLabel: 'Organisation',
    organisationHint: 'The short name of your organisation, as it appears in your address.',
    signingIn: 'Signing in…',
    // One message for every reason, matching the API. Telling somebody which half of the pair
    // was wrong tells an attacker the same thing.
    signInRejected: 'Those credentials were not accepted.',
    signInUnavailable: 'Sign-in is unavailable right now. Try again in a moment.',
  },
  nav: {
    main: 'Main',
    menu: 'Navigation',
    skipToContent: 'Skip to content',
    home: 'Home',
    account: 'Account',
    appearance: 'Appearance',
    lightMode: 'Light',
    darkMode: 'Dark',
  },
  error: {
    VALIDATION_FAILED: 'Some of the details are not valid.',
    NOT_FOUND: 'That item does not exist, or you do not have access to it.',
    FORBIDDEN: 'You do not have permission to do this.',
    UNAUTHENTICATED: 'Sign in to continue.',
    INVALID_TRANSITION: 'That is not a permitted change from the current state.',
    VERSION_CONFLICT: 'Someone else changed this first. Reload and try again.',
    DUPLICATE: 'That already exists.',
    LOCKED: 'This document is checked out by someone else.',
    LEGAL_HOLD: 'This document is under legal hold and cannot be removed.',
    QUOTA_EXCEEDED: 'Your storage quota is full.',
    RATE_LIMITED: 'Too many requests. Wait a moment and try again.',
    UNSUPPORTED_CONTENT: 'That file type is not accepted.',
    CONTENT_NOT_SCANNED: 'This file is still being checked for malware.',
    TENANT_READ_ONLY: 'Your organisation is currently read-only.',
    DEPENDENCY_UNAVAILABLE: 'A service this action needs is unavailable.',
    INTERNAL: 'Something went wrong on our side.',
  },
} as const;

/**
 * The catalogue's *shape*, with the English strings widened back to `string`.
 *
 * `en` is `as const` so that every key is known statically; without this widening the Arabic
 * catalogue would have to contain the English text to satisfy the type, which is the exact
 * opposite of the point.
 */
export type Catalogue = Widen<typeof en>;

type Widen<T> = {
  [K in keyof T]: T[K] extends string ? string : Widen<T[K]>;
};
