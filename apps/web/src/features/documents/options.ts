import type { Choice } from '../admin-shared';
import type { MetadataFieldDefinition } from './metadata-fields';

/**
 * What the record page's two dialogues need, and nothing the page itself renders — Phase 7.1C.
 *
 * These shapes exist because the data behind them is *only* needed after an interaction. Opening a
 * document used to fetch all of it on first paint: the tenant's categories, confidentiality levels,
 * users, departments, metadata fields, document types and the candidate folders for a move — seven
 * requests, for two dialogues that are closed, on a page whose reader usually only wanted to read.
 *
 * They live in their own module rather than beside the actions that produce them because
 * `actions.ts` carries `'use server'`, and a module marked that way is a list of callable server
 * functions rather than a place to declare a type.
 */

/** The pickers the properties form renders, resolved for one document's type. */
export interface DocumentEditOptions {
  readonly categories: readonly Choice[];
  /**
   * Only levels at or above the document's own rank.
   *
   * Filtered on the server, where the rank comparison already happened, because a picker offering a
   * lower level would be offering an action the API refuses: confidentiality may be raised and never
   * lowered.
   */
  readonly confidentialityLevels: readonly Choice[];
  readonly users: readonly Choice[];
  readonly departments: readonly Choice[];
  /** The document type's own fields, which decide what the properties form renders. */
  readonly fields: readonly MetadataFieldDefinition[];
}

/** The destinations a move may choose between — within the document's own library. */
export interface DocumentMoveOptions {
  readonly folders: readonly Choice[];
}
