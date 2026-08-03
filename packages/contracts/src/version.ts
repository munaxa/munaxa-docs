/**
 * The API version this contract set describes.
 *
 * A breaking change means a new prefix, never a silent change to this one
 * (`docs/architecture/15-api-architecture.md` §8).
 */
export const API_VERSION = 'v1' as const;
export const API_PREFIX = `api/${API_VERSION}` as const;
