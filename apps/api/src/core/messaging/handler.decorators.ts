import 'reflect-metadata';

import type { Command, Query } from './messages';

export const COMMAND_HANDLER_FOR = 'edms:command-handler-for';
export const QUERY_HANDLER_FOR = 'edms:query-handler-for';
export const EVENT_HANDLER_FOR = 'edms:event-handler-for';

export type MessageType = new (...args: never[]) => unknown;

/** Binds a handler class to the command it executes. One command, one handler, checked at boot. */
export const CommandHandlerFor = <TCommand extends Command<unknown>>(
  command: new (...args: never[]) => TCommand,
): ClassDecorator => {
  return (target) => {
    Reflect.defineMetadata(COMMAND_HANDLER_FOR, command, target);
  };
};

export const QueryHandlerFor = <TQuery extends Query<unknown>>(
  query: new (...args: never[]) => TQuery,
): ClassDecorator => {
  return (target) => {
    Reflect.defineMetadata(QUERY_HANDLER_FOR, query, target);
  };
};

/**
 * Binds a handler to an event *type string* rather than to a class: events arrive from the
 * outbox as data, having crossed a queue, and a class reference cannot survive that.
 */
export const EventHandlerFor = (eventType: string): ClassDecorator => {
  return (target) => {
    Reflect.defineMetadata(EVENT_HANDLER_FOR, eventType, target);
  };
};
