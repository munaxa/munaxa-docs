/**
 * The `LOCAL` driver's transfer capability, re-exported for suites that redeem one.
 *
 * A test that uploads has to do what a browser does: take the URL the adapter minted, read the
 * capability out of it, and write the bytes where it says. That means reaching into
 * `src/infrastructure/storage/`, and a suite living under `src/modules/` may not — the boundary
 * lint forbids it, correctly, because a test that reaches into another layer's internals is a test
 * that keeps passing after that layer's contract changes.
 *
 * So the reach happens here, in the layer whose job is composition, and a suite imports one
 * function. `tsconfig.build.json` excludes this directory, so nothing here is reachable from
 * production code.
 */
export {
  decodeTransferToken,
  encodeTransferToken,
} from '../infrastructure/storage/local-transfer-token';
export type { TransferGrant } from '../infrastructure/storage/local-transfer-token';
