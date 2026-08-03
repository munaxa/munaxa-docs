/**
 * `@edms/i18n` — every user-visible string in Munaxa Docs.
 *
 * A string literal rendered in a component or returned from a controller is a defect: it
 * cannot be translated, and it cannot be reviewed for tone.
 */
export * from './locale';
export * from './translate';
export type { Catalogue } from './catalogues/en';
export { en } from './catalogues/en';
export { ar } from './catalogues/ar';
