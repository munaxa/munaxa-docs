/**
 * The filesystem adapter, when there is one.
 *
 * A separate token from `STORAGE_PORT` because the transfer endpoints need the adapter *itself*
 * rather than the port: streaming bytes to a path is not something `StoragePort` describes, and it
 * must not be — an object-store deployment has no path to stream to, and putting one in the port
 * would oblige every driver to pretend it has a filesystem.
 *
 * Bound to `null` under every other driver, so the endpoints resolve, answer "not found", and stay
 * covered by the same tests in both deployment shapes.
 */
export const LOCAL_STORAGE_ADAPTER = Symbol('LocalStorageAdapter');
