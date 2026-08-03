import { Module } from '@nestjs/common';

/**
 * Storage — Where are the bytes, and are they intact?
 *
 * **Owns:** FileObject, UploadSession, dedupe, the antivirus gate
 * **Depends on:** — (the StoragePort only)
 *
 * Nothing in core. It is the only module that calls `STORAGE_PORT` and `ANTIVIRUS_PORT`.
 *
 * Phase 0.5 establishes this module's contracts: the repository and service interfaces in
 * `application/`, and the event contracts in `domain/events.ts`. The entities, use cases,
 * Prisma repositories and controllers that satisfy them are built by the phase that owns
 * this capability — see `README.md` in this folder.
 */
@Module({})
export class StorageModule {}
