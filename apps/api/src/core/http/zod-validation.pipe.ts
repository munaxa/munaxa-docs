import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodType } from 'zod';

import { ValidationError } from '../errors/application-errors';

/**
 * Validates a query, param or body against a schema from `@edms/contracts`.
 *
 * The schemas are shared with the web client, so a filter the UI can build is a filter the
 * API accepts, by construction. Unknown keys are rejected rather than stripped: silently
 * ignoring `?includeDeleted=true` teaches a caller that it worked.
 */
@Injectable()
export class ZodValidationPipe<TSchema extends ZodType> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(
          `The ${metadata.type} is not valid.`,
          error.issues.map((issue) => ({
            field: issue.path.join('.') || metadata.data || metadata.type,
            message: issue.message,
          })),
        );
      }
      throw error;
    }
  }
}
