import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import { DocumentModule } from '../document.module';
import { BulkDocumentsController } from '../presentation/bulk-documents.controller';
import { DocumentsController } from '../presentation/documents.controller';

/**
 * A literal path segment must be registered before the parameter that would swallow it.
 *
 * Found by trying to run a bulk operation for real. `POST /documents/bulk/restore` answered `500`,
 * and so did `GET /documents/bulk` — because `DocumentsController` was listed first and declares
 * `POST /documents/:id/restore` and `GET /documents/:id`. Nest matches routes in the order
 * controllers are registered, so `bulk` bound to `:id`, `AclGuard` asked the ACL resolver to
 * resolve a `DOCUMENT` scope whose identifier was the string `bulk`, and Prisma refused it as an
 * invalid UUID. Two shipped routes had been reachable only as errors since Phase 16.
 *
 * ## Why the assertion is on the order rather than on a response
 *
 * Because the order *is* the defect. A test that asserted "`POST /documents/bulk/restore` answers
 * 200" would need a database, a tenant, a caller and a deleted document, and would then be a test
 * of bulk restore that happens to fail when the route is shadowed — slow, and failing for a reason
 * its name does not give. This states the invariant directly: whatever else moves in this module,
 * the controller whose paths begin with a literal segment is registered before the controller whose
 * paths begin with a parameter.
 *
 * The behaviour itself was verified against a running API when the fix was made: both routes
 * answered as their contracts describe rather than `500`.
 */

function controllersOf(module: unknown): readonly unknown[] {
  return (Reflect.getMetadata('controllers', module as object) ?? []) as readonly unknown[];
}

describe('the document module registers its controllers in a routable order', () => {
  it('puts the bulk controller before the one whose paths start with :id', () => {
    const controllers = controllersOf(DocumentModule);
    const bulk = controllers.indexOf(BulkDocumentsController);
    const documents = controllers.indexOf(DocumentsController);

    expect(bulk).toBeGreaterThanOrEqual(0);
    expect(documents).toBeGreaterThanOrEqual(0);
    // Not "they are both present" — `bulk` strictly first, which is the property that makes
    // `/documents/bulk/restore` reach the bulk controller instead of the single-document one.
    expect(bulk).toBeLessThan(documents);
  });
});
