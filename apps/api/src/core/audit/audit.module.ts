import { Global, Module } from '@nestjs/common';

/**
 * Audit is written by every module and owned by none of them, so the port lives in core and
 * the Audit module binds the implementation that maintains the hash chain.
 */
@Global()
@Module({})
export class AuditModule {}
