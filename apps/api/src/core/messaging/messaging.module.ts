import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';

import { AuditBehavior } from './behaviors/audit.behavior';
import { ExceptionBehavior } from './behaviors/exception.behavior';
import { LoggingBehavior } from './behaviors/logging.behavior';
import { ValidationBehavior } from './behaviors/validation.behavior';
import { CommandBus, EventBus, QueryBus } from './buses';
import { Mediator } from './mediator';
import { PIPELINE_BEHAVIOR, type PipelineBehavior } from './messages';

/**
 * The message pipeline.
 *
 * Behaviour order is the contract, and it reads outward-in: exception translation wraps
 * everything, then logging, then validation, then audit, then the handler and its
 * transaction. Adding a behaviour means giving it an `order` and listing it in the factory
 * below — there is no second place to look.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    Mediator,
    CommandBus,
    QueryBus,
    EventBus,
    ExceptionBehavior,
    LoggingBehavior,
    ValidationBehavior,
    AuditBehavior,
    {
      provide: PIPELINE_BEHAVIOR,
      useFactory: (...behaviors: PipelineBehavior[]): PipelineBehavior[] => behaviors,
      inject: [ExceptionBehavior, LoggingBehavior, ValidationBehavior, AuditBehavior],
    },
  ],
  exports: [Mediator, CommandBus, QueryBus, EventBus],
})
export class MessagingModule {}
