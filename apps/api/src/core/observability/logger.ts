import { Global, Module } from '@nestjs/common';
import { StructuredLogger } from '@munaxa/logging';
import type { LoggerPort, LogFields } from '@munaxa/interfaces';

import { APP_CONFIG, type AppConfig } from '../config';

export const LOGGER = Symbol('Logger');

export type LogContext = LogFields;

/**
 * The product's logging surface, implemented entirely by `@munaxa/logging`.
 *
 * Munaxa Docs no longer configures pino, and no longer maintains its own redaction list. Both are
 * the platform's now: `StructuredLogger` writes the same JSON shape every Munaxa service writes,
 * and `defaultRedactor` covers a strict superset of the fields this product used to name — it adds
 * `x-api-key`, `clientsecret`, `otp`, `totp`, `mfacode`, `sessionid` and `csrftoken`, several of
 * which had appeared in this codebase and none of which the local list caught.
 *
 * The four level methods are kept because 152 call sites use them and mapping each to
 * `LoggerPort.log('info', …)` by hand is churn with no behavioural payoff. This is an ergonomic
 * adapter over the platform port, not a second implementation: there is no logging logic here at
 * all — every call forwards. Migrating the call sites to `LoggerPort` directly is tracked as
 * backlog rather than done silently.
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

/** Forwards the four level methods onto a `LoggerPort`. It holds no state and makes no decisions. */
class PlatformLoggerAdapter implements Logger {
  constructor(private readonly delegate: LoggerPort) {}

  debug(message: string, context: LogContext = {}): void {
    this.delegate.log('debug', message, context);
  }

  info(message: string, context: LogContext = {}): void {
    this.delegate.log('info', message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.delegate.log('warn', message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.delegate.log('error', message, context);
  }

  child(bindings: LogContext): Logger {
    return new PlatformLoggerAdapter(this.delegate.child(bindings));
  }
}

export function createLogger(config: AppConfig): Logger {
  return new PlatformLoggerAdapter(
    new StructuredLogger({
      level: config.log.level,
      service: config.app.name,
      environment: config.env,
      // `version` is not a first-class option on the platform logger, so it rides along as a
      // binding — which puts it on every line exactly as the previous `base` did.
      bindings: { version: config.app.version },
    }),
  );
}

@Global()
@Module({
  providers: [
    {
      provide: LOGGER,
      useFactory: (config: AppConfig) => createLogger(config),
      inject: [APP_CONFIG],
    },
  ],
  exports: [LOGGER],
})
export class LoggerModule {}
