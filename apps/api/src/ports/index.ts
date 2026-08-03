/**
 * The ports: every external capability the application depends on, named for the capability
 * and never for the vendor.
 *
 * A use case may import from here. It may never import an adapter
 * (`docs/architecture/02-backend-architecture.md` §4).
 */
export * from './antivirus.port';
export * from './cache.port';
export * from './clock.port';
export * from './notification.port';
export * from './ocr.port';
export * from './preview.port';
export * from './queue.port';
export * from './search.port';
export * from './storage.port';
