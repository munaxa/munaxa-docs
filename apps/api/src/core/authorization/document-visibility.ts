import { Prisma } from '@prisma/client';

import type { VisibilityFilter, VisibilityRegion } from './acl-resolver.port';

/**
 * 08 §7's Query row, as a Prisma predicate on `document`.
 *
 * `ACL_RESOLVER.visibilityFilter` decides *what* the caller reaches — the resolution, the walk, the
 * inheritance breaks, deny-wins. This is the mechanical translation of that answer into a `WHERE`,
 * and it is here rather than in the document repository because Phase 15 gave it a second caller:
 * the approvals report filters tasks by the reach of the document each belongs to, and that is the
 * same predicate on the same model.
 *
 * **A second copy would have been the exact failure this seam exists to prevent**, one level down.
 * The resolver is the single place the decision is made; two translations of one decision are two
 * chances to write `OR` where the other writes `AND`, and the one that got it wrong would be the
 * one nobody was watching. Phase 14 wrote this logic once and its comments — about `OR: [{}]` in
 * particular — are the sort of thing that is learned once and forgotten by the second implementer.
 *
 * It lives in `core/` because `core/` is what every module may import and no module may be imported
 * *by*: the alternative is one module's `infrastructure/` reaching into another's, which the
 * boundary lint forbids. It knows about `document` and `folder`, which is the one thing worth
 * noticing about the placement — it is a *predicate builder for one model*, not a general
 * authorisation utility, and its name says so.
 */
export function documentVisibilityWhere(filter: VisibilityFilter): Prisma.DocumentWhereInput {
  const allowed = filter.allowedRegions.map(regionCondition);
  const denied = filter.deniedRegions.map(regionCondition).filter((c) => !isUnconditional(c));

  // An **unconditional** allowed region — the tenant-level role grant with no inheritance break to
  // cut out of it — is not `OR: [{}]`. Prisma does not read an empty object inside an `OR` as
  // "everything"; it reads it as a branch with no condition and drops it, so a caller who could see
  // the whole tenant would see nothing. The unconditional case is the overwhelming majority of
  // requests, so it is spelled as the absence of an allow clause rather than as a branch.
  const unconditional = allowed.some(isUnconditional);
  return {
    AND: [
      // No allowed region at all is the closed default, spelled as a predicate that matches nothing
      // rather than as an omitted clause — an omitted clause is one refactor away from reading as
      // "no restriction", which is the wrong direction for this function to fail in.
      ...(unconditional ? [] : [allowed.length === 0 ? { id: NO_SUCH_ID } : { OR: allowed }]),
      ...(denied.length === 0 ? [] : [{ NOT: { OR: denied } }]),
    ],
  };
}

/** A predicate that matches nothing, spelled as an identifier no row can hold. */
export const NO_SUCH_ID = '00000000-0000-0000-0000-000000000000';

function isUnconditional(condition: Prisma.DocumentWhereInput): boolean {
  return Object.keys(condition).length === 0;
}

function regionCondition(region: VisibilityRegion): Prisma.DocumentWhereInput {
  const bases: Prisma.DocumentWhereInput[] = [];
  if (region.tenantWide) {
    bases.push({});
  }
  if (region.libraryIds.length > 0) {
    bases.push({ folder: { libraryId: { in: [...region.libraryIds] } } });
  }
  for (const path of region.folderPaths) {
    bases.push({ folder: { OR: [{ path }, { path: { startsWith: `${path}.` } }] } });
  }
  if (region.documentIds.length > 0) {
    bases.push({ id: { in: [...region.documentIds] } });
  }
  if (bases.length === 0) {
    return { id: NO_SUCH_ID };
  }
  const base: Prisma.DocumentWhereInput =
    bases.length === 1 ? (bases[0] as Prisma.DocumentWhereInput) : { OR: bases };
  if (region.excludedFolderPaths.length === 0) {
    return base;
  }
  return {
    AND: [
      base,
      {
        NOT: {
          OR: region.excludedFolderPaths.map((path) => ({
            folder: { OR: [{ path }, { path: { startsWith: `${path}.` } }] },
          })),
        },
      },
    ],
  };
}
