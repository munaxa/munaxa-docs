import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  RequestMethod,
  type Type,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { ALL_PERMISSIONS, Permission, type PermissionKey, isPermissionKey } from '@edms/domain';

import { LOGGER, type Logger } from '../observability/logger';
import { PUBLIC_ROUTE } from '../auth/public.decorator';
import { REQUIRED_PERMISSIONS } from './permission.decorator';

/**
 * Permissions no route declares, on purpose — Phase 6.3.
 *
 * The registry's two original checks both run **route → catalogue**: they catch a mutating route
 * with no permission, and a route naming a permission that does not exist. Neither can see the
 * opposite direction, and that is where two real defects hid for eighteen phases: `document:archive`
 * and `library:view` were in the catalogue, in `08-permission-model.md` §6's matrix and seeded to
 * roles, while **no route declared either**. An administrator granting one was granting a control
 * that did not exist, and nothing failed. Phase 6.0 found them by counting references by hand,
 * which is not a check — it is somebody remembering to look.
 *
 * So the third check runs catalogue → routes. It cannot simply require every permission to have a
 * route, because two legitimately do not, and the point of an allowlist is that *being on it is a
 * decision somebody took*. Adding a permission that nothing enforces now costs a line here and the
 * sentence explaining it, rather than costing nothing and being discovered by an audit.
 */
const UNROUTED_BY_DESIGN: Readonly<Record<PermissionKey, string>> = Object.freeze({
  /**
   * Enforced in the use case rather than at a route, and correctly: it is not a gate on
   * `GET /search` — everybody with `document:view` may search — but a *modifier* that decides
   * whether the ACL predicate is applied at all. `search.service.ts` reads it, and the trail
   * records `SEARCH_PERFORMED` when it fires, which is the audit a bypass deserves.
   */
  [Permission.SEARCH_ALL]: 'A capability modifier read by SearchService, not a route gate.',
  /**
   * Reserved. `08-permission-model.md` §6 gives it to the tenant administrator and the document
   * controller, which is the shape of a permission for *shared* report definitions — and no
   * definition is shared: `report-definition.service.ts` scopes every one to its owner and says so.
   * Binding it to personal definitions would put an author's own saved filter behind a permission
   * the matrix does not give them.
   */
  [Permission.REPORT_MANAGE]: 'Reserved for shared report definitions, which do not exist yet.',
  /**
   * Enforced, and not by a decorator — which this check found on its first run, and which is the
   * third legitimate reason a catalogue entry names no route.
   *
   * `POST /approval-tasks/{id}/decision` is gated on `document:approve`; a *rejection* additionally
   * needs this, and whether the request is one is a property of the body rather than of the route.
   * `@RequirePermission` declares a route's fixed requirement and cannot express "only when the
   * decision is REJECTED", so `ApprovalController.decide` checks it in the handler and
   * `WorkflowEngine` resolves it per object as well. Two keys because the matrix has two: a
   * reviewer who may agree is not necessarily one who may refuse.
   */
  [Permission.DOCUMENT_REJECT]:
    'Conditionally enforced in ApprovalController.decide on a rejection.',
} as Record<PermissionKey, string>);

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
    /**
     * And every permission a route names must exist — Phase 18.
     *
     * The check above cannot catch a route that declares a *misspelt* permission: a string is a
     * string, `RbacGuard` compares it against grants that will never contain it, and the route
     * refuses everybody for ever. That reads to a customer as "the feature is broken" rather than
     * as a defect, and it is discovered by whoever files the ticket rather than by whoever
     * deployed. `@edms/domain`'s catalogue is the whole set, so this is a set difference.
     */
    const unknown = this.findUnknownPermissions();
    if (unknown.length > 0) {
      throw new Error(
        `These routes declare permissions that are not in the catalogue:\n  - ${unknown.join('\n  - ')}`,
      );
    }
    /**
     * And every permission in the catalogue is either declared by a route or listed above — Phase
     * 6.3, and the direction the first two checks cannot see.
     */
    const phantom = this.findPhantomPermissions();
    if (phantom.length > 0) {
      throw new Error(
        `These permissions are in the catalogue and enforced by no route. Wire them, or add them to ` +
          `UNROUTED_BY_DESIGN with the reason:\n  - ${phantom.join('\n  - ')}`,
      );
    }
    this.logger.info('Route permission check passed', {
      controllers: this.discovery.getControllers().length,
    });
  }

  /** `Controller.method → permission` for each declared permission the catalogue does not have. */
  private findUnknownPermissions(): string[] {
    const offenders: string[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | null;
      if (!instance) {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance) as Type<unknown>;
      const controllerClass = (wrapper.metatype ?? prototype) as Type<unknown>;

      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = instance[methodName];
        if (typeof handler !== 'function') {
          continue;
        }
        const declared = this.reflector.getAllAndOverride<unknown>(REQUIRED_PERMISSIONS, [
          handler,
          controllerClass,
        ]);
        if (!Array.isArray(declared)) {
          continue;
        }
        for (const permission of declared as unknown[]) {
          if (typeof permission !== 'string' || !isPermissionKey(permission)) {
            offenders.push(`${wrapper.name}.${methodName} → ${String(permission)}`);
          }
        }
      }
    }
    return offenders;
  }

  /** Catalogue entries no route declares and no line above excuses. */
  private findPhantomPermissions(): string[] {
    const declared = new Set<string>();
    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as Record<string, unknown> | null;
      if (!instance) {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance) as Type<unknown>;
      const controllerClass = (wrapper.metatype ?? prototype) as Type<unknown>;
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const handler = instance[methodName];
        if (typeof handler !== 'function') {
          continue;
        }
        const found = this.reflector.getAllAndOverride<unknown>(REQUIRED_PERMISSIONS, [
          handler,
          controllerClass,
        ]);
        if (Array.isArray(found)) {
          for (const permission of found as unknown[]) {
            if (typeof permission === 'string') {
              declared.add(permission);
            }
          }
        }
      }
    }
    return ALL_PERMISSIONS.filter(
      (permission) => !declared.has(permission) && UNROUTED_BY_DESIGN[permission] === undefined,
    );
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
