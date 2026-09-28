import { type RequestHandler, json } from 'express';

import { API_VERSION } from '@edms/contracts';
import { Settings } from '@edms/domain';

/**
 * How large a request body may be — RC validation, D-17.
 *
 * Every route keeps the platform's default (100 KiB): bytes go to storage through presigned URLs,
 * never through the API, so no ordinary request needs more (`15-api-architecture.md` §4). The one
 * family that legitimately does is **bulk**: `bulk.maxObjects` promises up to 5 000 objects by
 * default and up to 50 000 when raised, and 5 000 identifiers are ~195 KiB of JSON. Under the
 * default limit anything past ~2 600 identifiers was refused before validation ran — as a 500 —
 * so the setting's own contract was unreachable.
 *
 * The bulk routes therefore get their own, larger, bounded parser, and the bound is not a guess:
 *
 * - an **identifier list** at the setting's *ceiling* (50 000 × `"<uuid>",`) fits, with room for the
 *   request's other fields — so for metadata, restore, export and approval requests, no value an
 *   administrator can configure is unreachable;
 * - a **bulk upload** — whose items carry a filename and a title as well — fits at the setting's
 *   *default* even with every name at its maximum length in three-byte characters.
 *
 * Past that, the answer is a clean 413 rather than a 500 (`AllExceptionsFilter`), which is the
 * transport saying "too large to read" — distinct from, and checked before, the bulk layer's own
 * `bulk.maxObjects` refusal of a body it *could* read. `body-limits.spec.ts` holds both sums to
 * account, so changing the ceiling or a field's length without revisiting this fails a test.
 */
export const BULK_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/** The worst-case bytes of one identifier in a JSON array: the quoted UUID and its comma. */
export const IDENTIFIER_BYTES = 36 + 2 + 1;

/** Room for everything in a bulk body that is not the list — a metadata payload, a comment. */
export const BULK_ENVELOPE_BYTES = 256 * 1024;

/** The largest `bulk.maxObjects` an administrator can configure. */
export const BULK_MAX_OBJECTS_CEILING =
  Settings.BULK_MAX_OBJECTS.bounds?.max ?? Number.POSITIVE_INFINITY;

/** The routes that read a list of objects, under the global prefix and the URI version. */
export const BULK_ROUTES: readonly string[] = [
  `/api/${API_VERSION}/documents/bulk`,
  `/api/${API_VERSION}/approval-tasks/bulk`,
];

/**
 * The bulk routes' JSON parser. Registered before the platform's own, so a bulk body is parsed
 * once, here, against this limit; the platform's parser sees it already read and leaves it alone,
 * and every other route keeps the default.
 *
 * **Wrapped, and the wrapper's name matters.** Nest decides whether to register its own JSON
 * parser by looking for a middleware *named* `jsonParser` already in the stack — and `json()`
 * returns exactly that. Registered bare, this would have made Nest skip its parser for the whole
 * application, and every non-bulk route would have received no body at all.
 */
export function bulkBodyParser(): RequestHandler {
  const read = json({ limit: BULK_BODY_LIMIT_BYTES });
  return function bulkJsonParser(request, response, next) {
    read(request, response, next);
  };
}
