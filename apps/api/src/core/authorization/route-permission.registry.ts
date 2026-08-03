import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { LOGGER, type Logger } from '../observability/logger';
import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { REQUIRED_PERMISSIONS } from './permission.decorator';

const MUTATING_METHODS = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

/**
 * The boot-time assertion behind "every mutating route declares a permission".
 *
 * A rule that is only written down is a rule that is eventually broken by someone in a
 * hurry. This one refuses to start the process, which is the only enforcement that survives
 * a deadline (`docs/architecture/15-api-architecture.md` §5).
 */
@Injectable()
export class RoutePermissionRegistry implements OnApplicationBootstrap {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    const ungated = this.findUngatedMutatingRoutes();
    if (ungated.length > 0) {
      throw new Error(
        `These mutating routes declare no permission and no reason for being public:\n  - ${ungated.join('\n  - ')}`,
      );
    }
    this.logger.info('Route permission check passed', {
      controllers: this.discovery.getControllers().length,
    });
  }

  private findUngatedMutatingRoutes(): string[] {
    const offenders: string[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | null;
      if (!instance) {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance) as Type<unknown>;
      /**
       * Class-level metadata lives on the **constructor**, not on the prototype.
       *
       * `@RequirePermission` used as a class decorator calls `SetMetadata` against the class itself,
       * and `RbacGuard` finds it because `context.getClass()` returns the constructor. Looking it up
       * on the prototype — as this did — finds nothing, so a controller gated once for all its routes
       * was reported as if every route were ungated. The prototype is still what method names are
       * scanned from; only the metadata target was wrong.
       */
      const controllerClass = (wrapper.metatype ?? prototype) as Type<unknown>;
      const basePath = wrapper.metatype
        ? (this.reflector.get<string>(PATH_METADATA, wrapper.metatype) ?? '')
        : '';

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = instance[methodName];
        if (typeof handler !== 'function') {
          continue;
        }
        const httpMethod = this.reflector.get<RequestMethod>(METHOD_METADATA, handler);
        if (httpMethod === undefined || !MUTATING_METHODS.has(httpMethod)) {
          continue;
        }
        // Same two targets, in the same order, as `RbacGuard` uses at runtime. If this pair ever
        // disagreed with the guard's, the assertion would be checking a different rule from the one
        // being enforced — which is worse than not asserting at all.
        const permissions = this.reflector.getAllAndOverride<unknown>(REQUIRED_PERMISSIONS, [
          handler,
          controllerClass,
        ]);
        const publicReason = this.reflector.getAllAndOverride<unknown>(PUBLIC_ROUTE, [
          handler,
          controllerClass,
        ]);
        if (!permissions && !publicReason) {
          offenders.push(`${wrapper.name}.${methodName} (${basePath})`);
        }
      }
    }
    return offenders;
  }
}
