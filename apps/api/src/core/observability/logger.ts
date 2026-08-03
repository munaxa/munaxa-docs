import { Global, Module } from '@nestjs/common';
import pino, { type Logger as PinoLogger } from 'pino';

import { APP_CONFIG, type AppConfig } from '../config';

export const LOGGER = Symbol('Logger');

export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

/**
 * Structured logging with the sensitive fields redacted at the logger, not at each call site.
 *
 * A log line may carry a correlation id, a tenant id and a user id. It may never carry a
 * credential, a token, file content or a personal identifier
 * (`docs/architecture/17-security-architecture.md` §7) — which is why redaction is
 * configured once here rather than trusted to every future caller.
 */
const REDACTED_PATHS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'secret',
  '*.password',
  '*.token',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
];

class PinoAdapter implements Logger {
  constructor(private readonly delegate: PinoLogger) {}

  debug(message: string, context: LogContext = {}): void {
    this.delegate.debug(context, message);
  }

  info(message: string, context: LogContext = {}): void {
    this.delegate.info(context, message);
  }

  warn(message: string, context: LogContext = {}): void {
    this.delegate.warn(context, message);
  }

  error(message: string, context: LogContext = {}): void {
    this.delegate.error(context, message);
  }

  child(bindings: LogContext): Logger {
    return new PinoAdapter(this.delegate.child(bindings));
  }
}

export function createLogger(config: AppConfig): Logger {
  return new PinoAdapter(
    pino({
      level: config.log.level,
      base: { service: config.app.name, version: config.app.version, env: config.env },
      redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime,
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
