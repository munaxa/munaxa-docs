/**
 * The test foundation: port doubles and fixtures, importable by every module's tests.
 *
 * Excluded from the build (`tsconfig.build.json`), so nothing here can be reached from
 * production code by accident.
 */
export * from './fake-ports';
export * from './factories';
