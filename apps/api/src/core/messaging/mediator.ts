import { Inject, Injectable, type OnApplicationBootstrap, Optional } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';

import type { DomainEvent } from '@edms/domain';

import { LOGGER, type Logger } from '../observability/logger';
import {
  type Command,
  type CommandHandler,
  type EventHandler,
  type MessageEnvelope,
  type MessageResult,
  PIPELINE_BEHAVIOR,
  type PipelineBehavior,
  type Query,
  type QueryHandler,
} from './messages';
import {
  COMMAND_HANDLER_FOR,
  EVENT_HANDLER_FOR,
  QUERY_HANDLER_FOR,
  type MessageType,
} from './handler.decorators';

/**
 * Resolves the handler for a message and runs it through the pipeline.
 *
 * Handlers are discovered once at bootstrap rather than looked up per message, and a message
 * with two handlers — or a command with none — fails at startup. Both are configuration
 * mistakes that are cheap to find now and expensive to find at 3 a.m.
 */
@Injectable()
export class Mediator implements OnApplicationBootstrap {
  private readonly commandHandlers = new Map<MessageType, CommandHandler<Command<unknown>>>();
  private readonly queryHandlers = new Map<MessageType, QueryHandler<Query<unknown>>>();
  private readonly eventHandlers = new Map<string, EventHandler[]>();
  private behaviors: PipelineBehavior[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Optional()
    @Inject(PIPELINE_BEHAVIOR)
    private readonly registeredBehaviors: PipelineBehavior[] | PipelineBehavior | null = null,
  ) {}

  onApplicationBootstrap(): void {
    this.behaviors = (
      Array.isArray(this.registeredBehaviors)
        ? this.registeredBehaviors
        : this.registeredBehaviors
          ? [this.registeredBehaviors]
          : []
    ).sort((left, right) => left.order - right.order);

    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as object | null;
      if (!instance || typeof instance !== 'object' || !wrapper.metatype) {
        continue;
      }
      const metatype = wrapper.metatype as MessageType;
      this.registerCommand(metatype, instance);
      this.registerQuery(metatype, instance);
      this.registerEvent(metatype, instance);
    }

    this.logger.info('Message handlers registered', {
      commands: this.commandHandlers.size,
      queries: this.queryHandlers.size,
      events: this.eventHandlers.size,
      behaviors: this.behaviors.length,
    });
  }

  async send<TCommand extends Command<unknown>>(
    command: TCommand,
  ): Promise<MessageResult<TCommand>> {
    const handler = this.commandHandlers.get(command.constructor as MessageType) as
      CommandHandler<TCommand> | undefined;
    if (!handler) {
      throw new Error(`No handler is registered for command ${command.constructor.name}.`);
    }
    return (await this.through(
      { kind: 'command', name: command.constructor.name, message: command },
      () => handler.execute(command),
    )) as MessageResult<TCommand>;
  }

  async ask<TQuery extends Query<unknown>>(query: TQuery): Promise<MessageResult<TQuery>> {
    const handler = this.queryHandlers.get(query.constructor as MessageType) as
      QueryHandler<TQuery> | undefined;
    if (!handler) {
      throw new Error(`No handler is registered for query ${query.constructor.name}.`);
    }
    return (await this.through(
      { kind: 'query', name: query.constructor.name, message: query },
      () => handler.execute(query),
    )) as MessageResult<TQuery>;
  }

  /**
   * Events fan out: zero handlers is legitimate, and one failing handler must not stop the
   * others. Failures are logged and rethrown as a group so the job retries as a whole — the
   * handlers are idempotent, so re-running the ones that succeeded is safe.
   */
  async publish(event: DomainEvent): Promise<void> {
    const handlers = this.eventHandlers.get(event.type) ?? [];
    const failures: unknown[] = [];

    for (const handler of handlers) {
      try {
        await this.through({ kind: 'event', name: event.type, message: event }, () =>
          handler.handle(event),
        );
      } catch (error) {
        failures.push(error);
        this.logger.error('Event handler failed', {
          eventType: event.type,
          eventId: event.eventId,
          handler: handler.constructor.name,
        });
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} handler(s) failed for ${event.type}`);
    }
  }

  private through(envelope: MessageEnvelope, terminal: () => Promise<unknown>): Promise<unknown> {
    const run = (index: number): Promise<unknown> => {
      const behavior = this.behaviors[index];
      return behavior ? behavior.handle(envelope, () => run(index + 1)) : terminal();
    };
    return run(0);
  }

  private registerCommand(metatype: MessageType, instance: object): void {
    const target = Reflect.getMetadata(COMMAND_HANDLER_FOR, metatype) as MessageType | undefined;
    if (!target) {
      return;
    }
    if (this.commandHandlers.has(target)) {
      throw new Error(`Command ${target.name} has more than one handler.`);
    }
    this.commandHandlers.set(target, instance as CommandHandler<Command<unknown>>);
  }

  private registerQuery(metatype: MessageType, instance: object): void {
    const target = Reflect.getMetadata(QUERY_HANDLER_FOR, metatype) as MessageType | undefined;
    if (!target) {
      return;
    }
    if (this.queryHandlers.has(target)) {
      throw new Error(`Query ${target.name} has more than one handler.`);
    }
    this.queryHandlers.set(target, instance as QueryHandler<Query<unknown>>);
  }

  private registerEvent(metatype: MessageType, instance: object): void {
    const eventType = Reflect.getMetadata(EVENT_HANDLER_FOR, metatype) as string | undefined;
    if (!eventType) {
      return;
    }
    const existing = this.eventHandlers.get(eventType) ?? [];
    existing.push(instance as EventHandler);
    this.eventHandlers.set(eventType, existing);
  }
}
