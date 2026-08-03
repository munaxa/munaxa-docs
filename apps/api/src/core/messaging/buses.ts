import { Injectable } from '@nestjs/common';

import type { DomainEvent } from '@edms/domain';

import { Mediator } from './mediator';
import type { Command, MessageResult, Query } from './messages';

/**
 * The three buses are deliberately thin faces over one mediator: separating *what a caller
 * may do* (send a command, ask a query, publish an event) from *how it is dispatched* keeps
 * a controller from being able to publish an event, or a projection from sending a command.
 */
@Injectable()
export class CommandBus {
  constructor(private readonly mediator: Mediator) {}

  send<TCommand extends Command<unknown>>(command: TCommand): Promise<MessageResult<TCommand>> {
    return this.mediator.send(command);
  }
}

@Injectable()
export class QueryBus {
  constructor(private readonly mediator: Mediator) {}

  ask<TQuery extends Query<unknown>>(query: TQuery): Promise<MessageResult<TQuery>> {
    return this.mediator.ask(query);
  }
}

@Injectable()
export class EventBus {
  constructor(private readonly mediator: Mediator) {}

  /** In-process fan-out for events already committed and dispatched. Not a substitute for
   *  the outbox: nothing publishes here from inside a transaction. */
  publish(event: DomainEvent): Promise<void> {
    return this.mediator.publish(event);
  }
}
