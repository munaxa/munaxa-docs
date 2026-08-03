import 'reflect-metadata';

import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../observability/logger';
import { CommandHandlerFor } from './handler.decorators';
import { Mediator } from './mediator';
import { Command, type MessageEnvelope, type PipelineBehavior } from './messages';

class ArchiveThing extends Command<string> {
  constructor(readonly id: string) {
    super();
  }
}

@CommandHandlerFor(ArchiveThing)
class ArchiveThingHandler {
  execute(command: ArchiveThing): Promise<string> {
    return Promise.resolve(`archived:${command.id}`);
  }
}

const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};

function discoveryOf(...instances: object[]): DiscoveryService {
  return {
    getProviders: () => instances.map((instance) => ({ instance, metatype: instance.constructor })),
    getControllers: () => [],
  } as unknown as DiscoveryService;
}

function mediatorWith(behaviors: PipelineBehavior[], ...handlers: object[]): Mediator {
  const mediator = new Mediator(discoveryOf(...handlers), silentLogger, behaviors);
  mediator.onApplicationBootstrap();
  return mediator;
}

describe('Mediator', () => {
  it('routes a command to its registered handler', async () => {
    const mediator = mediatorWith([], new ArchiveThingHandler());
    await expect(mediator.send(new ArchiveThing('doc-1'))).resolves.toBe('archived:doc-1');
  });

  it('fails loudly when no handler is registered', async () => {
    const mediator = mediatorWith([]);
    await expect(mediator.send(new ArchiveThing('doc-1'))).rejects.toThrowError(
      /No handler is registered/,
    );
  });

  it('refuses two handlers for one command, at bootstrap', () => {
    expect(() =>
      mediatorWith([], new ArchiveThingHandler(), new ArchiveThingHandler()),
    ).toThrowError(/more than one handler/);
  });

  it('runs behaviours outermost-first and lets one short-circuit the handler', async () => {
    const order: string[] = [];
    const trace = (name: string, position: number): PipelineBehavior => ({
      order: position,
      handle: async (_envelope: MessageEnvelope, next) => {
        order.push(`${name}:in`);
        const result = await next();
        order.push(`${name}:out`);
        return result;
      },
    });
    const mediator = mediatorWith(
      [trace('second', 20), trace('first', 10)],
      new ArchiveThingHandler(),
    );

    await mediator.send(new ArchiveThing('doc-1'));
    expect(order).toEqual(['first:in', 'second:in', 'second:out', 'first:out']);
  });

  it('lets a behaviour replace the result without calling the handler', async () => {
    const replay: PipelineBehavior = { order: 5, handle: () => Promise.resolve('replayed') };
    const mediator = mediatorWith([replay], new ArchiveThingHandler());
    await expect(mediator.send(new ArchiveThing('doc-1'))).resolves.toBe('replayed');
  });
});
